/**
 * Click loopback for discord-ui's queued buttons/select menus (custom_id `artie:<turn>:<n>`).
 * A click is a paid LLM turn, so this file also owns the caps that keep a popular message from
 * burning the budget: one click-turn per user per message, a total cap per message
 * (ARTIE_BUTTON_CLICK_CAP, default 8), and a brownout cutoff (critical → no LLM call at all).
 */
import {
  MessageFlags,
  ButtonInteraction,
  SelectMenuInteraction,
  ActionRowBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { logger } from '../../shared/logger.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { processUserIntent } from '../4-reply/stream-reply.js';
import { engineClient } from '../3-ask-engine/engine-client.js';

/** `artie:<shortTurnId>:<index>` — the only shape discord-ui ever builds server-side. */
export function parseArtieCustomId(customId: string): { turnId: string; index: number } | null {
  const match = /^artie:([^:]+):(\d+)$/.exec(customId);
  if (!match) return null;
  return { turnId: match[1], index: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// Click caps: in-memory, keyed by the Discord message id the component lives on, with a TTL
// so a long-dead message's counter doesn't sit in memory forever.
// ---------------------------------------------------------------------------

const CLICK_COUNTER_TTL_MS = 10 * 60 * 1000;

interface ClickCounter {
  total: number;
  users: Set<string>;
  expiresAt: number;
}

const clickCounters = new Map<string, ClickCounter>();

function pruneExpiredCounters(now: number): void {
  if (clickCounters.size < 500) return;
  for (const [messageId, counter] of clickCounters) {
    if (counter.expiresAt <= now) {
      clickCounters.delete(messageId);
    }
  }
}

function getClickCap(): number {
  const raw = parseInt(process.env.ARTIE_BUTTON_CLICK_CAP || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 8;
}

type ClickCheck =
  | { allowed: true }
  | { allowed: false; reason: 'duplicate' | 'cap' };

/** Pure check — does NOT record the click. Call recordClick() only once allowed is true. */
export function checkClickCap(messageId: string, userId: string): ClickCheck {
  const now = Date.now();
  pruneExpiredCounters(now);

  let counter = clickCounters.get(messageId);
  if (!counter || counter.expiresAt <= now) {
    counter = { total: 0, users: new Set(), expiresAt: now + CLICK_COUNTER_TTL_MS };
    clickCounters.set(messageId, counter);
  }

  if (counter.users.has(userId)) {
    return { allowed: false, reason: 'duplicate' };
  }
  if (counter.total >= getClickCap()) {
    return { allowed: false, reason: 'cap' };
  }
  return { allowed: true };
}

export function recordClick(messageId: string, userId: string): void {
  const counter = clickCounters.get(messageId);
  if (!counter) return;
  counter.total++;
  counter.users.add(userId);
}

/** Exposed for tests: wipe all counters between cases. */
export function resetClickCountersForTests(): void {
  clickCounters.clear();
}

/**
 * The combined refusal decision — pure, so every branch is testable without a live brownout
 * lookup or a real interaction. Brownout wins over the cap: under `critical` nobody gets a
 * click-turn, cap-room or not. Returns the ephemeral text to send, or null to proceed.
 */
export function clickRefusal(brownoutMode: string, check: ClickCheck): string | null {
  if (brownoutMode === 'critical') {
    return 'Running lean right now — @ me instead.';
  }
  if (!check.allowed) {
    if (check.reason === 'duplicate') {
      return 'Already got your pick on this one.';
    }
    return "That one's closed out — too many clicks already.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The click → turn text, and the handler itself.
// ---------------------------------------------------------------------------

function describeSelection(interaction: ButtonInteraction | SelectMenuInteraction): string {
  if (interaction.isButton()) {
    return (interaction.component as any)?.label || interaction.customId;
  }
  const values = interaction.values;
  const labels = values.map((val) => {
    const opt = interaction.component?.options?.find((o) => o.value === val);
    return opt?.label || val;
  });
  return labels.join(', ');
}

/** What the turn sends to Artie, in his words: who clicked, what they picked, which message,
 *  when — e.g. `[button] ejfox picked "Yes" on your message "Should I deploy?" (12s after you posted)`. */
export function buildClickTurnText(
  displayName: string,
  label: string,
  originalMessageContent: string,
  postedAtMs: number
): string {
  const snippet = (originalMessageContent || '').slice(0, 80);
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - postedAtMs) / 1000));
  return `[button] ${displayName} picked "${label}" on your message "${snippet}" (${elapsedSeconds}s after you posted)`;
}

export async function handleComponentClick(
  interaction: ButtonInteraction | SelectMenuInteraction
): Promise<void> {
  const messageId = interaction.message.id;
  const userId = interaction.user.id;

  // The DM gate for interactions already runs at the top of setupInteractionHandler before
  // dispatch reaches here, so every click arriving here is either in a guild or from someone
  // already paired for DMs. Blocked users still need an explicit check — the gate is about
  // DM access, not about the blocklist.
  if (isBlockedUser(userId)) {
    await interaction
      .reply({ content: "This account can't interact with Artie.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  // A button with a form opens it (free: no LLM call). The caps apply when it's submitted.
  if (interaction.isButton()) {
    const form = await engineClient.getComponentForm(interaction.customId);
    if (form) {
      await interaction.showModal(buildFormModal(interaction.customId, form)).catch((error: unknown) => {
        logger.warn('Could not open a form for a click:', error);
      });
      return;
    }
  }

  const label = describeSelection(interaction);
  const displayName = (interaction.member as { displayName?: string } | null)?.displayName
    || interaction.user.username;
  const clickContent = buildClickTurnText(
    displayName,
    label,
    interaction.message.content,
    interaction.message.createdTimestamp
  );
  let componentType: 'button' | 'select';
  if (interaction.isButton()) {
    componentType = 'button';
  } else {
    componentType = 'select';
  }
  logger.info(`🔘 Component click [${interaction.customId}]:`, { userId, messageId, label });
  await runInteractionTurn(interaction, messageId, clickContent, componentType);
}

// ---------------------------------------------------------------------------
// Forms behind buttons (2026-11-24): the button's custom_id `artie:<turn>:<n>` becomes the
// modal's `artie-form:<turn>:<n>`; fields are f0..f4. The submit is a turn like a click.
// ---------------------------------------------------------------------------

type FormSpec = NonNullable<Awaited<ReturnType<typeof engineClient.getComponentForm>>>;

const FORM_PREFIX = 'artie-form:';
/** Longest answer per field; a turn shouldn't balloon from one pasted wall of text. */
const FORM_ANSWER_MAX = 1000;

export function formModalId(buttonCustomId: string): string {
  return `${FORM_PREFIX}${buttonCustomId.slice('artie:'.length)}`;
}

export function buttonIdOfForm(modalCustomId: string): string | null {
  if (!modalCustomId.startsWith(FORM_PREFIX)) {
    return null;
  }
  return `artie:${modalCustomId.slice(FORM_PREFIX.length)}`;
}

export function buildFormModal(buttonCustomId: string, form: FormSpec): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(formModalId(buttonCustomId)).setTitle(form.title || 'Form');
  form.fields.slice(0, 5).forEach((field, i) => {
    let style = TextInputStyle.Short;
    if (field.paragraph) {
      style = TextInputStyle.Paragraph;
    }
    const input = new TextInputBuilder()
      .setCustomId(`f${i}`)
      .setLabel(field.label)
      .setStyle(style)
      .setRequired(field.required !== false)
      // The same cap the submit applies, shown to the person typing (Codex: no silent cut).
      .setMaxLength(FORM_ANSWER_MAX);
    if (field.placeholder) {
      input.setPlaceholder(field.placeholder);
    }
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  });
  return modal;
}

/** What a submitted form tells Artie: who, which form, on which message, and each answer. */
export function buildFormTurnText(
  displayName: string,
  title: string,
  answers: Array<{ label: string; value: string }>,
  originalMessageContent: string
): string {
  const snippet = (originalMessageContent || '').slice(0, 80);
  const lines = answers.map((a) => `- ${a.label}: ${a.value || '(left blank)'}`);
  return [`[form] ${displayName} filled in "${title}" on your message "${snippet}":`, ...lines].join('\n');
}

export async function handleFormSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const userId = interaction.user.id;
  if (isBlockedUser(userId)) {
    await interaction
      .reply({ content: "This account can't interact with Artie.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }
  const buttonId = buttonIdOfForm(interaction.customId);
  let form: FormSpec | null = null;
  if (buttonId) {
    form = await engineClient.getComponentForm(buttonId);
  }
  // Answers by field order; labels from the stored form (a restart leaves "field N").
  const answers: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < 5; i++) {
    let value: string;
    try {
      value = interaction.fields.getTextInputValue(`f${i}`);
    } catch {
      break;
    }
    let label = `field ${i + 1}`;
    if (form && form.fields[i]) {
      label = form.fields[i].label;
    }
    answers.push({ label, value: value.trim().slice(0, FORM_ANSWER_MAX) });
  }
  let title = 'a form';
  if (form) {
    title = form.title;
  }
  const displayName = (interaction.member as { displayName?: string } | null)?.displayName
    || interaction.user.username;
  const message = interaction.message;
  const messageId = message?.id ?? interaction.customId;
  const content = buildFormTurnText(displayName, title, answers, message?.content ?? '');
  logger.info(`📝 Form submitted [${interaction.customId}]:`, { userId, messageId, fields: answers.length });
  await runInteractionTurn(interaction, messageId, content, 'form');
}

/** Caps, then one paid turn answering in place (shared by clicks and form submits). */
async function runInteractionTurn(
  interaction: ButtonInteraction | SelectMenuInteraction | ModalSubmitInteraction,
  messageId: string,
  turnText: string,
  componentType: 'button' | 'select' | 'form'
): Promise<void> {
  const userId = interaction.user.id;
  let brownoutMode = 'normal';
  try {
    brownoutMode = (await engineClient.getBrownoutMode()).mode;
  } catch (error) {
    logger.warn('Component click: brownout check failed, proceeding:', error);
  }

  const check = checkClickCap(messageId, userId);
  const refusal = clickRefusal(brownoutMode, check);
  if (refusal) {
    await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  recordClick(messageId, userId);

  await interaction.deferReply();

  await processUserIntent({
    content: turnText,
    userId,
    username: interaction.user.username,
    source: 'button',
    metadata: {
      customId: interaction.customId,
      componentType,
    },
    // Same shape a normal message gets (top-level guildId/channelId), so guild-scoped
    // memory and last-time rules still apply instead of falling back to owner-only defaults.
    context: {
      platform: 'discord',
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId ?? undefined,
    },

    respond: async (content: string) => {
      await interaction.editReply(content);
    },

    updateProgress: async (status: string) => {
      await interaction.editReply(status);
    },

    // So a click's reply can itself carry buttons (e.g. "Yes" → "Great, which one? [A] [B]").
    // editReply on a deferred reply preserves whatever content was already set.
    attachComponents: async (rows: Array<Record<string, unknown>>) => {
      try {
        const actionRows = rows.map((row) => ActionRowBuilder.from(row as any));
        await interaction.editReply({ components: actionRows as any });
      } catch (error) {
        logger.warn('Failed to attach components to click reply:', error);
      }
    },
  });
}

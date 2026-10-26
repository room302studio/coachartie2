/**
 * Click loopback for discord-ui's queued buttons/select menus (custom_id `artie:<turn>:<n>`).
 * A click is a paid LLM turn, so this file also owns the caps that keep a popular message from
 * burning the budget: one click-turn per user per message, a total cap per message
 * (ARTIE_BUTTON_CLICK_CAP, default 8), and a brownout cutoff (critical → no LLM call at all).
 */
import { MessageFlags, ButtonInteraction, SelectMenuInteraction } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { processUserIntent } from '../4-reply/stream-reply.js';
import * as engine from '../../engine/api.js';

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

export type ClickCheck =
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

  try {
    const brownout = await engine.brownoutStatus();
    if (engine.isOk(brownout) && (brownout.body as { mode?: string })?.mode === 'critical') {
      await interaction
        .reply({
          content: "Running lean right now — @ me instead.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
  } catch (error) {
    logger.warn('Component click: brownout check failed, proceeding:', error);
  }

  const check = checkClickCap(messageId, userId);
  if (!check.allowed) {
    let content: string;
    if (check.reason === 'duplicate') {
      content = 'Already got your pick on this one.';
    } else {
      content = "That one's closed out — too many clicks already.";
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  recordClick(messageId, userId);

  const label = describeSelection(interaction);
  const displayName = (interaction.member as { displayName?: string } | null)?.displayName
    || interaction.user.username;
  const clickContent = buildClickTurnText(
    displayName,
    label,
    interaction.message.content,
    interaction.message.createdTimestamp
  );

  logger.info(`🔘 Component click [${interaction.customId}]:`, {
    userId,
    messageId,
    label,
  });

  await interaction.deferReply();

  let componentType: 'button' | 'select';
  if (interaction.isButton()) {
    componentType = 'button';
  } else {
    componentType = 'select';
  }

  await processUserIntent({
    content: clickContent,
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
  });
}

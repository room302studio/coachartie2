import { ChannelType } from 'discord.js';
import type { Message, Collection } from 'discord.js';
import Chance from 'chance';
import { logger } from '../../shared/logger.js';
import { isBlockedUser } from '../../shared/blocklist.js';
import { isStaffRole } from '../../shared/staff-role.js';
import { violatesOutputSafety } from '../4-reply/output-safety.js';

// Own Chance instance (seedless RNG — behaviorally identical to any other).
const chance = new Chance();

const MIN_CHANNEL_HISTORY = 10; // Minimum messages to fetch
export const MAX_CHANNEL_HISTORY = 25; // Maximum messages to fetch

/**
 * Fetch the message this one is replying to (if any), as reply context.
 * Blocked users are invisible — a reply to one of their messages yields null.
 */
export async function fetchReplyContext(message: Message): Promise<{
  messageId: string;
  author: string;
  content: string;
  timestamp: string;
} | null> {
  try {
    // Check if this message is a reply
    if (!message.reference?.messageId) {
      return null;
    }

    // Fetch the referenced message
    const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);

    // Blocked users are invisible to Artie — a reply to one of their messages
    // gets no reply context rather than smuggling their words into the prompt.
    if (!referencedMessage || isBlockedUser(referencedMessage.author.id)) {
      return null;
    }

    // Return formatted reply context
    return {
      messageId: referencedMessage.id,
      author: referencedMessage.author.displayName || referencedMessage.author.username,
      // cleanContent resolves <@id> mentions to readable @names so the LLM
      // doesn't have to guess who a numeric ID is
      content: referencedMessage.cleanContent || referencedMessage.content,
      timestamp: referencedMessage.createdAt.toISOString(),
    };
  } catch (error) {
    // Handle gracefully - message might be deleted, or we might lack permissions
    logger.debug(`Could not fetch reply context for message ${message.id}:`, error);
    return null;
  }
}

/**
 * Who a history line is addressed to, resolved WITHOUT fetching anything extra —
 * discord.js fills `mentions.repliedUser` and `mentions.users` from the gateway payload
 * regardless of the MessageContent intent (same fact `isReplyToBot` in speak-gate.ts relies
 * on), so this works today and gets a richer excerpt automatically once
 * DISCORD_PRIVILEGED_INTENTS is on (the reply target's own content becomes readable).
 *
 * `window` is the same prefetched channel page fetchChannelHistory is rendering — the reply
 * target is usually in it, which is what lets us attach a short excerpt of Artie's own
 * message without a second Discord call. A target outside the window still gets an author
 * (from `repliedUser`), just no excerpt.
 */
export function resolveAddressing(
  msg: Message,
  window: Collection<string, Message>,
  botId?: string
): {
  replyToAuthor?: string;
  replyToIsSelf?: boolean;
  replyToExcerpt?: string;
  mentions?: string[];
  addressedElsewhere?: boolean;
} {
  const out: {
    replyToAuthor?: string;
    replyToIsSelf?: boolean;
    replyToExcerpt?: string;
    mentions?: string[];
    addressedElsewhere?: boolean;
  } = {};

  const refId = msg.reference?.messageId;
  let replyTargetId: string | undefined;
  if (refId) {
    const target = window.get(refId);
    const repliedUser = msg.mentions.repliedUser; // populated even without MessageContent
    const targetAuthorId = target?.author.id ?? repliedUser?.id;
    const targetAuthorName = target
      ? target.author.displayName || target.author.username
      : repliedUser
        ? repliedUser.displayName || repliedUser.username
        : undefined;
    if (targetAuthorName && !isBlockedUser(targetAuthorId ?? '')) {
      out.replyToAuthor = targetAuthorName;
      out.replyToIsSelf = targetAuthorId === botId;
      replyTargetId = targetAuthorId;
      if (out.replyToIsSelf && target) {
        const excerpt = (target.cleanContent || target.content || '').trim().slice(0, 120);
        if (excerpt) out.replyToExcerpt = excerpt;
      }
    }
  }

  if (msg.mentions.users.size > 0) {
    // A reply-with-ping fills BOTH mentions.repliedUser and mentions.users with the same
    // person — without this exclusion that renders as the redundant "[↳@Bob →@Bob]"
    // instead of just "[↳@Bob]".
    const names = Array.from(msg.mentions.users.values())
      .filter((u) => u.id !== botId && u.id !== replyTargetId && !isBlockedUser(u.id))
      .map((u) => u.displayName || u.username);
    if (names.length > 0) out.mentions = Array.from(new Set(names));
  }

  // "This message was for someone else": a reply or @-mention naming a human who isn't
  // Artie, with no mention of Artie anywhere in the same line.
  const mentionsBot = botId ? msg.mentions.has(botId) : false;
  const replyTargetsOther = out.replyToAuthor !== undefined && !out.replyToIsSelf;
  const mentionsOther = (out.mentions?.length ?? 0) > 0;
  if (!mentionsBot && (replyTargetsOther || mentionsOther)) {
    out.addressedElsewhere = true;
  }

  return out;
}

/**
 * Fetch recent channel history for context
 * Randomly fetches 10-25 messages to give Artie conversational context
 */
export async function fetchChannelHistory(
  message: Message,
  prefetched?: Collection<string, Message>
): Promise<
  Array<{
    author: string;
    content: string;
    timestamp: string;
    isBot: boolean;
    isSelf: boolean;
    replyToAuthor?: string;
    replyToIsSelf?: boolean;
    replyToExcerpt?: string;
    mentions?: string[];
    addressedElsewhere?: boolean;
  }>
> {
  try {
    // Use the shared prefetch when provided (one Discord API call feeds history +
    // attachments + URLs); otherwise fetch a randomized window (10-25) ourselves.
    const messages =
      prefetched ??
      (await message.channel.messages.fetch({
        limit: chance.integer({ min: MIN_CHANNEL_HISTORY, max: MAX_CHANNEL_HISTORY }),
        before: message.id,
      }));

    // Convert to context format, enriching the speaker label so Artie can tell people apart
    // and knows who's staff even from history (the staff-respect rule otherwise only saw the
    // current speaker). Names are run through the output floor so a slur-username can't ride
    // into every prompt (closes the known username-injection gap; floor was the only backstop).
    return Array.from(messages.values())
      .reverse() // Chronological order (oldest first)
      // Blocked users don't exist as far as Artie is concerned: their messages
      // never enter his context, so he can't quote, answer, or mention them.
      .filter((msg) => !isBlockedUser(msg.author.id))
      .map((msg) => {
        const display = msg.author.displayName || msg.author.username;
        const uname = msg.author.username;
        const roles = msg.member?.roles?.cache; // cached only — no extra fetch in the hot path
        const isStaff = roles ? roles.some((r) => isStaffRole(r.name)) : false;

        const safeDisplay = violatesOutputSafety(display) ? '[name hidden]' : display;
        const safeUname = violatesOutputSafety(uname) ? 'hidden' : uname;
        let label = safeDisplay;
        if (safeUname && safeUname.toLowerCase() !== safeDisplay.toLowerCase()) {
          label += ` (@${safeUname})`;
        }
        if (msg.author.bot) label += ' [bot]';
        else if (isStaff) label += ' [staff]';

        // Embeds are where bots keep their actual content (Steamy's Steam reviews, GitHub
        // events) — msg.content is empty for those, so every such post read as a blank
        // line and Artie couldn't discuss the review right above him. Render them as text.
        let content = msg.cleanContent || msg.content;
        if (msg.embeds.length > 0) {
          const embedText = msg.embeds
            .map((e) => {
              const fields = (e.fields || []).map((f) => `${f.name}: ${f.value}`).join('; ');
              return [e.title, e.description, fields].filter(Boolean).join(' — ');
            })
            .filter(Boolean)
            .join(' | ')
            .slice(0, 600);
          if (embedText) content = content ? `${content}\n[embed] ${embedText}` : `[embed] ${embedText}`;
        }

        const addressing = resolveAddressing(msg, messages, message.client.user?.id);

        return {
          author: label,
          // cleanContent resolves <@id> mentions to readable @names — raw IDs in
          // history were making Artie mix up who said what to whom
          content,
          timestamp: msg.createdAt.toISOString(),
          isBot: msg.author.bot,
          // Only Artie's OWN messages become assistant turns downstream. Without this,
          // every webhook/other-bot message read as something Artie himself said.
          isSelf: msg.author.id === message.client.user?.id,
          ...addressing,
        };
      })
      // Without the MessageContent intent, other people's messages arrive blank (only
      // @mentions of Artie, DMs and his own posts carry text). A blank line is only noise
      // when it ALSO carries no reply/mention metadata — who-replied-to-whom and who got
      // @-pinged are still worth a line even with nothing to quote.
      .filter(
        (h) =>
          h.content.trim().length > 0 ||
          h.replyToAuthor !== undefined ||
          (h.mentions?.length ?? 0) > 0
      );
  } catch (error) {
    logger.error('Failed to fetch channel history:', error);
    return [];
  }
}

/**
 * Fetch recent attachments from the channel (last ~10 messages)
 */
export async function fetchRecentAttachments(
  message: Message,
  prefetched?: Collection<string, Message>
): Promise<
  Array<{
    id: string;
    name: string | null;
    url: string;
    contentType: string | null;
    size: number;
    proxyUrl: string | null;
    author: string;
    authorId: string;
    messageId: string;
    timestamp: string;
  }>
> {
  try {
    const messages =
      prefetched ?? (await message.channel.messages.fetch({ limit: 12, before: message.id }));

    const attachments: Array<{
      id: string;
      name: string | null;
      url: string;
      contentType: string | null;
      size: number;
      proxyUrl: string | null;
      author: string;
      authorId: string;
      messageId: string;
      timestamp: string;
    }> = [];

    for (const msg of messages.values()) {
      if (isBlockedUser(msg.author.id)) continue; // invisible: their uploads don't reach context
      if (!msg.attachments || msg.attachments.size === 0) continue;

      msg.attachments.forEach((att) => {
        attachments.push({
          id: att.id,
          name: att.name,
          url: att.url,
          contentType: att.contentType ?? null,
          size: att.size,
          proxyUrl: att.proxyURL ?? null,
          author: msg.author.displayName || msg.author.username,
          authorId: msg.author.id,
          messageId: msg.id,
          timestamp: msg.createdAt.toISOString(),
        });
      });

      if (attachments.length >= 10) break; // cap to keep context small
    }

    return attachments.slice(0, 10);
  } catch (error) {
    logger.error('Failed to fetch recent attachments:', error);
    return [];
  }
}

/**
 * Extract up to a few recent URLs from recent messages (excluding bot).
 */
export async function fetchRecentUrls(
  message: Message,
  prefetched?: Collection<string, Message>
): Promise<string[]> {
  try {
    const messages =
      prefetched ?? (await message.channel.messages.fetch({ limit: 12, before: message.id }));
    const urls: string[] = [];

    for (const msg of messages.values()) {
      if (msg.author.bot || isBlockedUser(msg.author.id)) continue;
      const tokens = msg.content.split(/\s+/);

      // Collect URLs from message content
      for (const token of tokens) {
        try {
          const parsed = new URL(token);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            const normalized = parsed.toString();
            if (!urls.includes(normalized)) {
              urls.push(normalized);
            }
          }
        } catch {
          // not a URL, skip
        }
        if (urls.length >= 5) break;
      }

      // Also include URLs from embeds if present
      if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
          if (embed.url && !urls.includes(embed.url)) {
            urls.push(embed.url);
          }
          if (urls.length >= 5) break;
        }
      }

      if (urls.length >= 5) break; // cap before later trim
    }

    return urls.slice(0, 5);
  } catch (error) {
    logger.error('Failed to fetch recent URLs:', error);
    return [];
  }
}

/**
 * The one Discord fetch the three views above share (moved out of handleMessageAsIntent,
 * wave 5).
 */
export async function fetchChannelWindow(
  message: Message,
  shortId: string
): Promise<Collection<string, Message> | undefined> {
  // ENHANCED: Fetch recent channel context ONCE, then derive history + attachments +
  // URLs from the same window. These used to be three separate identical Discord API
  // fetches of the same messages, awaited sequentially (~3× the round-trip latency and
  // 3× the rate-limit budget on the hot path). Fetch fails soft → transforms fall back.
  let prefetchedChannel: Collection<string, Message> | undefined;
  try {
    prefetchedChannel = await message.channel.messages.fetch({
      limit: MAX_CHANNEL_HISTORY,
      before: message.id,
    });
  } catch (e) {
    logger.warn(`Failed to prefetch channel window [${shortId}] — transforms will re-fetch`);
  }
  return prefetchedChannel;
}

// Channel detection constants
export const GUILD_CHANNEL_TYPE = 0; // Discord guild text channel type

/**
 * Helper: Check if channel name indicates robot interaction
 */
export function isRobotChannelName(channel: Message['channel']): boolean {
  return (
    (channel.type === GUILD_CHANNEL_TYPE &&
      'name' in channel &&
      (channel.name?.includes('🤖') || channel.name?.includes('robot'))) ||
    false
  );
}

/**
 * Helper: Check if message is in a forum thread (Discord Discussions)
 */
export async function isForumThread(message: Message): Promise<boolean> {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }

  // Get the parent channel to check if it's a forum
  const parent = message.channel.parent;
  return parent?.type === ChannelType.GuildForum;
}

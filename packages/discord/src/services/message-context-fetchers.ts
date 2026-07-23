import type { Message, Collection } from 'discord.js';
import Chance from 'chance';
import { logger, isBlockedUser } from '@coachartie/shared';
import { violatesOutputSafety } from './user-intent-processor.js';

// Own Chance instance (seedless RNG — behaviorally identical to any other).
const chance = new Chance();

// Staff roles that earn the [staff] tag in history labels (mirrors the current-speaker check).
export const HISTORY_STAFF_ROLE_RE =
  /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/i;

export const MIN_CHANNEL_HISTORY = 10; // Minimum messages to fetch
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
        const isStaff = roles ? roles.some((r) => HISTORY_STAFF_ROLE_RE.test(r.name)) : false;

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
        };
      });
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

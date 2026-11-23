/**
 * Artie's own small writes in Discord, the "body" moves he asked for on 2026-11-23: start a
 * thread, start a forum post, fix a message he already sent. One place for the rules:
 *
 *  - the server is always the conversation's (the caller passes it from turn context);
 *  - a thread may be started in the channel he's talking in, anywhere; elsewhere, and forum
 *    posts at all, only in POST_GUILD_IDS (Room 302 Studio, the same whitelist as
 *    discord-send-message), so he can't seed posts in servers that didn't ask for that;
 *  - he can edit only messages he wrote, in this server;
 *  - nothing he writes pings anyone (allowedMentions parse: []), whatever the text says;
 *  - banned people are scrubbed exactly like his normal replies.
 *
 * Typed against discord.js with no `any` (EJ, 2026-11-23: "be strict as fuck"); this file is
 * on the no-explicit-any list in eslint.config.mjs.
 */
import {
  ChannelFlags,
  ChannelType,
  type AnyThreadChannel,
  type Client,
  type ForumChannel,
  type GuildBasedChannel,
  type MediaChannel,
  type MessageMentionOptions,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';
import { scrubBlockedUserMentions } from '../../shared/blocklist.js';

/** Room 302 Studio: where Artie may start threads and forum posts on his own. */
export const POST_GUILD_IDS = new Set(['932719842522443928']);
/** Discord's message limit. Longer text is refused, never silently cut (Codex). */
const MAX_LEN = 2000;
const TOO_LONG = `that text is over Discord's ${MAX_LEN}-character limit: shorten it or split it`;
const MAX_TITLE = 100;
const NO_PINGS: MessageMentionOptions = { parse: [] };
/** Discord API error codes: Unknown Channel, Unknown Message, Missing Access, Missing Permissions. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const SNOWFLAKE = /^\d{15,22}$/;

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

/** Trimmed, capped, and scrubbed of banned people exactly like his normal replies. */
function clean(value: unknown, max: number): string {
  return scrubBlockedUserMentions(String(value ?? '').trim()).slice(0, max);
}

function tooLong(value: unknown): boolean {
  return String(value ?? '').trim().length > MAX_LEN;
}

function fail(status: number, error: string): Result {
  return { status, body: { success: false, error } };
}

/** Discord's numeric error code, when the error carries one. */
function discordCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

function isForumLike(ch: GuildBasedChannel): ch is ForumChannel | MediaChannel {
  return ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia;
}

function isPlainText(ch: GuildBasedChannel): ch is TextChannel {
  return ch.type === ChannelType.GuildText;
}

function isAnnouncement(ch: GuildBasedChannel): ch is NewsChannel {
  return ch.type === ChannelType.GuildAnnouncement;
}

/** The channel if it exists in this guild, else null; outages still throw. */
async function channelInGuild(
  discordClient: Client,
  guildId: string,
  channelId: string
): Promise<GuildBasedChannel | null> {
  if (!SNOWFLAKE.test(channelId)) {
    return null;
  }
  try {
    const ch = await discordClient.channels.fetch(channelId);
    if (ch && !ch.isDMBased() && ch.guildId === guildId) {
      return ch;
    }
    return null;
  } catch (error: unknown) {
    const code = discordCode(error);
    if (code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) {
      return null;
    }
    throw error;
  }
}

/** Discord's refusal, said plainly, or a generic failure. */
function discordFailure(what: string, error: unknown): Result {
  const code = discordCode(error);
  if (code === MISSING_PERMISSIONS || code === MISSING_ACCESS) {
    return fail(403, `I don't have permission to ${what} there`);
  }
  if (code === UNKNOWN_MESSAGE) {
    return fail(404, 'that message is gone (or the id is wrong)');
  }
  logger.warn(`[discord-write] ${what} failed:`, getErrorMessage(error));
  return fail(502, `Discord refused: ${getErrorMessage(error).slice(0, 200)}`);
}

export interface ThreadOptions {
  /** Where to start it; defaults to the conversation channel. */
  channelId?: string;
  name: string;
  /** First message in the thread. */
  message?: string;
  /** Start the thread from this existing message instead of standalone. */
  messageId?: string;
}

export async function createThread(
  discordClient: Client,
  guildId: string | null,
  fromChannelId: string | undefined,
  opts: ThreadOptions
): Promise<Result> {
  if (!guildId) {
    return fail(400, 'threads only work inside a server');
  }
  const name = clean(opts.name, MAX_TITLE);
  if (!name) {
    return fail(400, 'give the thread a name');
  }
  if (tooLong(opts.message)) {
    return fail(400, TOO_LONG);
  }
  if (opts.messageId && !SNOWFLAKE.test(String(opts.messageId))) {
    return fail(400, 'messageId must be a message id');
  }
  const target = String(opts.channelId || fromChannelId || '');
  try {
    const ch = await channelInGuild(discordClient, guildId, target);
    if (!ch) {
      return fail(404, 'no such channel in this server');
    }
    if (ch.id !== fromChannelId && !POST_GUILD_IDS.has(guildId)) {
      return fail(403, 'outside Room 302 I only start threads in the channel we are talking in');
    }
    if (isForumLike(ch)) {
      return fail(400, 'that is a forum: use discord-forums create-post');
    }
    let thread: AnyThreadChannel;
    if (opts.messageId) {
      // From an existing message: text and announcement channels both support it (Codex).
      if (!isPlainText(ch) && !isAnnouncement(ch)) {
        return fail(400, 'threads can only start in a text or announcement channel');
      }
      const start = await ch.messages.fetch(String(opts.messageId));
      thread = await start.startThread({ name });
    } else {
      // Standalone: plain text channels only (announcement channels make a different kind).
      if (!isPlainText(ch)) {
        return fail(400, 'a standalone thread needs a regular text channel; give a messageId to thread off a post');
      }
      // Explicitly public: a private thread would be invisible to the person who asked (Codex).
      thread = await ch.threads.create({ name, type: ChannelType.PublicThread });
    }
    const body: Record<string, unknown> = {
      success: true,
      threadId: thread.id,
      name: thread.name,
      url: `https://discord.com/channels/${guildId}/${thread.id}`,
    };
    const message = clean(opts.message, MAX_LEN);
    if (message) {
      // The thread exists either way: report it, so a retry doesn't make a duplicate (Codex).
      try {
        await thread.send({ content: message, allowedMentions: NO_PINGS });
      } catch (error: unknown) {
        body.messageError = `thread created, but the first message failed: ${getErrorMessage(error).slice(0, 200)}`;
      }
    }
    return { status: 200, body };
  } catch (error: unknown) {
    return discordFailure('start a thread', error);
  }
}

export interface PostOptions {
  forumId: string;
  title: string;
  message: string;
  /** A forum tag, by name (or id). */
  tag?: string;
}

export async function createForumPost(discordClient: Client, guildId: string | null, opts: PostOptions): Promise<Result> {
  if (!guildId) {
    return fail(400, 'forum posts only work inside a server');
  }
  if (!POST_GUILD_IDS.has(guildId)) {
    return fail(403, 'I only start forum posts in Room 302');
  }
  if (tooLong(opts.message)) {
    return fail(400, TOO_LONG);
  }
  const title = clean(opts.title, MAX_TITLE);
  const message = clean(opts.message, MAX_LEN);
  if (!title || !message) {
    return fail(400, 'a post needs a title and a first message');
  }
  try {
    const forum = await channelInGuild(discordClient, guildId, String(opts.forumId || ''));
    if (!forum || !isForumLike(forum)) {
      return fail(404, 'no such forum in this server');
    }
    // Tags by name (Codex: forums that require a tag reject untagged posts).
    const available = forum.availableTags;
    const tagNames = available.map((t) => t.name).join(', ');
    const appliedTags: string[] = [];
    if (opts.tag) {
      const wanted = String(opts.tag).trim().toLowerCase();
      const hit = available.find((t) => t.name.toLowerCase() === wanted || t.id === wanted);
      if (!hit) {
        return fail(400, `no tag "${opts.tag}" in that forum; tags: ${tagNames || '(none)'}`);
      }
      appliedTags.push(hit.id);
    }
    if (forum.flags.has(ChannelFlags.RequireTag) && appliedTags.length === 0) {
      return fail(400, `that forum requires a tag; pick one of: ${tagNames}`);
    }
    const post = await forum.threads.create({
      name: title,
      message: { content: message, allowedMentions: NO_PINGS },
      appliedTags,
    });
    return {
      status: 200,
      body: { success: true, threadId: post.id, title: post.name, url: `https://discord.com/channels/${guildId}/${post.id}` },
    };
  } catch (error: unknown) {
    return discordFailure('start a forum post', error);
  }
}

export interface EditOptions {
  channelId: string;
  messageId: string;
  message: string;
}

export async function editOwnMessage(
  discordClient: Client,
  guildId: string | null,
  who: { askerId: string | null; fromChannelId: string | undefined; askerIsOwner: boolean },
  opts: EditOptions
): Promise<Result> {
  if (!guildId) {
    return fail(400, 'editing only works inside a server');
  }
  // Authority (Codex High): only in the channel this conversation is in, where the asker is
  // already talking; anywhere else only EJ. Otherwise anyone could have Artie rewrite his
  // announcement in a channel they can't post in.
  if (!who.askerIsOwner && String(opts.channelId || '') !== String(who.fromChannelId || '')) {
    return fail(403, 'I only edit my messages in the channel we are talking in');
  }
  if (tooLong(opts.message)) {
    return fail(400, TOO_LONG);
  }
  const message = clean(opts.message, MAX_LEN);
  if (!message) {
    return fail(400, 'give the new text');
  }
  if (!SNOWFLAKE.test(String(opts.messageId || ''))) {
    return fail(400, 'give the id of the message to edit');
  }
  try {
    const ch = await channelInGuild(discordClient, guildId, String(opts.channelId || ''));
    if (!ch || !ch.isTextBased()) {
      return fail(404, 'no such channel in this server');
    }
    const original = await ch.messages.fetch(String(opts.messageId));
    if (original.author.id !== discordClient.user?.id) {
      return fail(403, 'I can only edit my own messages');
    }
    await original.edit({ content: message, allowedMentions: NO_PINGS });
    return {
      status: 200,
      body: { success: true, url: `https://discord.com/channels/${guildId}/${ch.id}/${original.id}` },
    };
  } catch (error: unknown) {
    return discordFailure('edit that message', error);
  }
}

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
  type Message,
  type MessageMentionOptions,
  type NewsChannel,
  type TextChannel,
  type User,
} from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/errors.js';
import { isBlockedUser, scrubBlockedUserMentions } from '../../shared/blocklist.js';
import { SNOWFLAKE } from '../../shared/discord-ids.js';

/** Room 302 Studio and SB2 pre-alpha: where Artie may post, start threads and forum posts on his own. */
// The one list (send_message reads it too, through gateway/api.ts mayPostElsewhere).
// SB2 pre-alpha testing added by EJ, 2026-11-24.
export const POST_GUILD_IDS = new Set(['932719842522443928', '1561813873089323219']);
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
      return fail(403, 'outside Room 302 and the SB2 alpha server I only start threads in the channel we are talking in');
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
    return fail(403, 'I only start forum posts in Room 302 and the SB2 alpha server');
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

// --- Delete, pin, and his polls (EJ, 2026-11-24: "give him all discord functionality") ---
// Same authority as an edit: the channel this conversation is in, anywhere only for EJ, and
// only inside this server. Ownership (his message, his poll) is checked here against Discord,
// never taken from the model.

/** Who is asking, and from where: the same shape editOwnMessage takes. */
export interface Asker {
  askerId: string | null;
  fromChannelId: string | undefined;
  askerIsOwner: boolean;
}

export interface MessageRef {
  /** Defaults to the conversation channel. */
  channelId?: string;
  messageId: string;
}

type Located = { ok: true; message: Message; channelId: string } | { ok: false; result: Result };

/** The message, if this asker may act on it from here; else the refusal. Discord errors throw. */
async function locate(discordClient: Client, guildId: string | null, who: Asker, ref: MessageRef, verb: string): Promise<Located> {
  if (!guildId) {
    return { ok: false, result: fail(400, `I can only ${verb} inside a server`) };
  }
  const channelId = String(ref.channelId || who.fromChannelId || '');
  if (!who.askerIsOwner && channelId !== String(who.fromChannelId || '')) {
    return { ok: false, result: fail(403, `I only ${verb} in the channel we are talking in`) };
  }
  if (!SNOWFLAKE.test(String(ref.messageId || ''))) {
    return { ok: false, result: fail(400, 'give the message id') };
  }
  const ch = await channelInGuild(discordClient, guildId, channelId);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, result: fail(404, 'no such channel in this server') };
  }
  // force: decisions below read live state (pinned, poll closed), never a stale cached copy (Codex).
  const message = await ch.messages.fetch({ message: String(ref.messageId), force: true });
  return { ok: true, message, channelId: ch.id };
}

function linkTo(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function isMine(discordClient: Client, message: Message): boolean {
  return message.author.id === discordClient.user?.id;
}

/** Delete a message HE sent. Other people's messages are moderation, which is EJ's. */
export async function deleteOwnMessage(discordClient: Client, guildId: string | null, who: Asker, ref: MessageRef): Promise<Result> {
  try {
    const found = await locate(discordClient, guildId, who, ref, 'delete messages');
    if (!found.ok) {
      return found.result;
    }
    if (!isMine(discordClient, found.message)) {
      return fail(403, 'I can only delete my own messages');
    }
    await found.message.delete();
    return { status: 200, body: { success: true, deleted: found.message.id, channelId: found.channelId } };
  } catch (error: unknown) {
    return discordFailure('delete that message', error);
  }
}

/** Pin or unpin any message in the channel (pinning someone's good post is normal). */
export async function setPinned(
  discordClient: Client,
  guildId: string | null,
  who: Asker,
  ref: MessageRef,
  pinned: boolean
): Promise<Result> {
  let verb = 'unpin messages';
  if (pinned) {
    verb = 'pin messages';
  }
  try {
    const found = await locate(discordClient, guildId, who, ref, verb);
    if (!found.ok) {
      return found.result;
    }
    const url = linkTo(String(guildId), found.channelId, found.message.id);
    if (found.message.pinned === pinned) {
      return { status: 200, body: { success: true, pinned, unchanged: true, url } };
    }
    if (pinned) {
      await found.message.pin();
    } else {
      await found.message.unpin();
    }
    return { status: 200, body: { success: true, pinned, url } };
  } catch (error: unknown) {
    return discordFailure(verb.replace(' messages', ' that message'), error);
  }
}

/** Close one of HIS polls now instead of waiting for it to expire. */
export async function endOwnPoll(discordClient: Client, guildId: string | null, who: Asker, ref: MessageRef): Promise<Result> {
  try {
    const found = await locate(discordClient, guildId, who, ref, 'end polls');
    if (!found.ok) {
      return found.result;
    }
    const poll = found.message.poll;
    if (!poll) {
      return fail(400, 'that message has no poll');
    }
    if (!isMine(discordClient, found.message)) {
      return fail(403, 'I can only end my own polls');
    }
    if (poll.resultsFinalized) {
      return fail(400, 'that poll is already closed');
    }
    await poll.end();
    return { status: 200, body: { success: true, ended: found.message.id, url: linkTo(String(guildId), found.channelId, found.message.id) } };
  } catch (error: unknown) {
    return discordFailure('end that poll', error);
  }
}

/** Voter names shown per answer; Discord polls show voters to everyone in the channel anyway. */
const MAX_VOTERS_SHOWN = 25;

/** A display name for a voter, or null for someone who opted out (counted, never named). */
function voterName(user: User): string | null {
  if (isBlockedUser(user.id)) {
    return null;
  }
  return user.globalName || user.username;
}

/** Read a poll in this server: question, tallies, who voted for what, and whether it's open. */
export async function readPollInGuild(discordClient: Client, guildId: string | null, ref: MessageRef, fromChannelId: string | undefined): Promise<Result> {
  if (!guildId) {
    return fail(400, 'polls only work inside a server');
  }
  if (!SNOWFLAKE.test(String(ref.messageId || ''))) {
    return fail(400, 'give the poll message id');
  }
  try {
    const ch = await channelInGuild(discordClient, guildId, String(ref.channelId || fromChannelId || ''));
    if (!ch || !ch.isTextBased()) {
      return fail(404, 'no such channel in this server');
    }
    // force: a cached copy can hold stale tallies (Codex), and zero counts would skip voters.
    const message = await ch.messages.fetch({ message: String(ref.messageId), force: true });
    const poll = message.poll;
    if (!poll) {
      return fail(404, 'no poll on that message');
    }
    const results: Array<{ text: string; votes: number; voters?: string[] }> = [];
    for (const answer of poll.answers.values()) {
      const row: { text: string; votes: number; voters?: string[] } = { text: answer.text ?? '', votes: answer.voteCount ?? 0 };
      if (!answer.partial && row.votes > 0) {
        const users = await answer.voters.fetch({ limit: MAX_VOTERS_SHOWN });
        row.voters = [...users.values()].map(voterName).filter((n): n is string => n !== null);
      }
      results.push(row);
    }
    let closesAt: string | null = null;
    if (poll.expiresAt) {
      closesAt = poll.expiresAt.toISOString();
    }
    return {
      status: 200,
      body: {
        success: true,
        question: poll.question.text ?? '',
        multi: poll.allowMultiselect,
        finalized: poll.resultsFinalized,
        closesAt,
        mine: isMine(discordClient, message),
        totalVotes: results.reduce((sum, r) => sum + r.votes, 0),
        results: results.sort((a, b) => b.votes - a.votes),
        url: linkTo(guildId, ch.id, message.id),
      },
    };
  } catch (error: unknown) {
    return discordFailure('read that poll', error);
  }
}

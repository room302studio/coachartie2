import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { readKillSwitch, writeManualMute, clearKillSwitch, writeBudgetOverride, getKillSwitchPath } from '../../shared/kill-switch.js';
import { easternDayKey } from '../../shared/eastern-day.js';
import { ForumTraversalService } from '../watchers/github/forum-traversal.js';
import { GitHubIntegrationService } from '../watchers/github/issue-sync.js';
import { Client, AttachmentBuilder, PollLayoutType } from 'discord.js';
import { mentionProxyRouter } from './mention-proxy-api.js';
import { violatesOutputSafety } from '../4-reply/output-safety.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: each /api route's handler body is an exported function below, returning the
// status + JSON it used to send. createApiRouter's routes send that result; gateway/api.ts
// calls the same functions in-process for the engine (tools, scheduler, sbat).
const reply = (status: number, body: any): ApiResult => ({ status, body });

// One GitHub client for forum sync, created on first use (it used to be created once per
// router, i.e. once at startup, from the same GITHUB_TOKEN).
let githubService: GitHubIntegrationService | null = null;
function getGitHubService(): GitHubIntegrationService {
  githubService ??= new GitHubIntegrationService(process.env.GITHUB_TOKEN || '');
  return githubService;
}

// Active-poll ledger: cap how many live Artie-created polls exist per channel so #prison
// can't weaponize "make polls whenever" into spam. In-memory is fine — polls are ephemeral
// and a restart clearing the ledger just resets the (already generous) budget.
const MAX_ACTIVE_POLLS_PER_CHANNEL = 2;
const activePolls = new Map<string, { messageId: string; expiresAt: number }[]>();

function countActivePolls(channelId: string): number {
  const now = Date.now();
  const live = (activePolls.get(channelId) || []).filter((p) => p.expiresAt > now);
  activePolls.set(channelId, live);
  return live.length;
}

function recordPoll(channelId: string, messageId: string, durationHours: number): void {
  const live = activePolls.get(channelId) || [];
  live.push({ messageId, expiresAt: Date.now() + durationHours * 3600_000 });
  activePolls.set(channelId, live);
}

// Emergency kill switch file (presence of file = Artie muted globally). See message-handler.ts.
const KILL_SWITCH_PATH = getKillSwitchPath();

// Presence system constants
const EJ_USER_ID = '688448399879438340';
const PRESENCE_INBOX_PATH = '/app/data/presence-inbox.jsonl';
const PRESENCE_OUTBOX_PATH = '/app/data/presence-outbox.jsonl';

// Track outbound presence messages for response matching
interface PresenceMessage {
  id: string;
  messageId: string;
  content: string;
  timestamp: string;
  responded: boolean;
}

// Load tracked presence messages
function loadPresenceOutbox(): PresenceMessage[] {
  try {
    if (!existsSync(PRESENCE_OUTBOX_PATH)) return [];
    const lines = readFileSync(PRESENCE_OUTBOX_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (e) {
    logger.warn('Failed to load presence outbox:', e);
    return [];
  }
}

// Append to presence outbox
function appendPresenceOutbox(msg: PresenceMessage): void {
  appendFileSync(PRESENCE_OUTBOX_PATH, JSON.stringify(msg) + '\n');
}

// Load inbox messages
function loadPresenceInbox(): any[] {
  try {
    if (!existsSync(PRESENCE_INBOX_PATH)) return [];
    const lines = readFileSync(PRESENCE_INBOX_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (e) {
    logger.warn('Failed to load presence inbox:', e);
    return [];
  }
}

// Append to inbox
function appendPresenceInbox(msg: any): void {
  appendFileSync(PRESENCE_INBOX_PATH, JSON.stringify(msg) + '\n');
}

// Rewrite inbox (for ack)
function rewritePresenceInbox(messages: any[]): void {
  writeFileSync(
    PRESENCE_INBOX_PATH,
    messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '')
  );
}

export function getKillSwitchState(): ApiResult {
  const state = readKillSwitch(KILL_SWITCH_PATH);
  return reply(200, {
    ...state,
    kind: state.muted ? state.kind : null,
    path: KILL_SWITCH_PATH,
  });
}

export function setKillSwitch(body: any): ApiResult {
  try {
    const enabled = body?.enabled === true || body?.enabled === 'true';
    if (enabled) {
      // Always written as a MANUAL mute — automation never lifts these.
      writeManualMute(KILL_SWITCH_PATH);
      logger.warn('🛑 KILL SWITCH ENABLED via API — Artie is now muted globally');
    } else {
      const state = readKillSwitch(KILL_SWITCH_PATH);
      if (state.muted && state.kind === 'budget') {
        writeBudgetOverride(easternDayKey(), KILL_SWITCH_PATH);
        logger.warn(
          `💸 Budget mute lifted by hand — daily cap overridden for the rest of ${easternDayKey()} (ET)`
        );
      }
      if (state.muted) {
        clearKillSwitch(KILL_SWITCH_PATH);
        logger.warn('✅ KILL SWITCH DISABLED via API — Artie is responding again');
      }
    }
    const after = readKillSwitch(KILL_SWITCH_PATH);
    return reply(200, { success: true, muted: after.muted, kind: after.muted ? after.kind : null });
  } catch (error) {
    logger.error('Failed to toggle kill switch:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listGuildForums(discordClient: Client, params: Record<string, string>): Promise<ApiResult> {
  const forumService = new ForumTraversalService(discordClient);
  try {
    const { guildId } = params;

    logger.info(`📋 API: Listing forums in guild ${guildId}`);
    const forums = await forumService.getForumsInGuild(guildId);

    const forumData = forums.map((forum) => ({
      id: forum.id,
      name: forum.name,
      type: forum.type,
      threadCount: forum.threads?.cache.size || 0,
    }));

    return reply(200, {
      success: true,
      guildId,
      count: forumData.length,
      forums: forumData,
    });
  } catch (error) {
    logger.error('Error listing forums:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listForumThreads(discordClient: Client, params: Record<string, string>): Promise<ApiResult> {
  const forumService = new ForumTraversalService(discordClient);
  try {
    const { forumId } = params;

    logger.info(`📝 API: Listing threads in forum ${forumId}`);
    const threads = await forumService.getThreadsInForum(forumId);

    const threadData = threads.map((thread) => ({
      id: thread.id,
      name: thread.name,
      messageCount: thread.messageCount || 0,
      createdAt: thread.createdAt?.toISOString(),
      archived: thread.archived,
    }));

    return reply(200, {
      success: true,
      forumId,
      count: threadData.length,
      threads: threadData,
    });
  } catch (error) {
    logger.error('Error listing threads:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getForumThread(discordClient: Client, params: Record<string, string>): Promise<ApiResult> {
  const forumService = new ForumTraversalService(discordClient);
  try {
    const { threadId } = params;

    logger.info(`💬 API: Fetching thread ${threadId}`);
    const threadData = await forumService.getThreadData(threadId);

    return reply(200, {
      success: true,
      thread: threadData,
    });
  } catch (error) {
    logger.error('Error fetching thread:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getForumSummary(discordClient: Client, params: Record<string, string>): Promise<ApiResult> {
  const forumService = new ForumTraversalService(discordClient);
  try {
    const { forumId } = params;

    logger.info(`📊 API: Getting summary for forum ${forumId}`);
    const summary = await forumService.getForumSummary(forumId);

    return reply(200, {
      success: true,
      summary,
    });
  } catch (error) {
    logger.error('Error getting forum summary:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function syncForumToGitHub(discordClient: Client, params: Record<string, string>, body: any): Promise<ApiResult> {
  const forumService = new ForumTraversalService(discordClient);
  const githubService = getGitHubService();
  try {
    const { forumId } = params;
    const { repo } = body;

    if (!repo) {
      return reply(400, {
        success: false,
        error: 'Repository (owner/repo) is required',
      });
    }

    logger.info(`🔄 API: Syncing forum ${forumId} to GitHub repo ${repo}`);

    // Parse repo reference
    const repoInfo = githubService.parseRepoReference(repo);
    if (!repoInfo) {
      return reply(400, {
        success: false,
        error: 'Invalid repository format. Use owner/repo or full GitHub URL',
      });
    }

    // Get threads from forum
    const threads = await forumService.getThreadsInForum(forumId);
    logger.info(`📥 Found ${threads.length} threads to sync`);

    // Get full thread data for each thread
    const threadDataPromises = threads.map((thread) => forumService.getThreadData(thread.id));
    const threadData = await Promise.all(threadDataPromises);

    // Get forum name for labeling
    const forum = await discordClient.channels.fetch(forumId);
    const forumName = (forum && 'name' in forum ? forum.name : null) || 'Unknown Forum';

    // Sync to GitHub
    const results = await githubService.syncThreadsToGitHub(
      repoInfo.owner,
      repoInfo.repo,
      threadData,
      forumName
    );

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    logger.info(`✅ Sync complete: ${successCount} succeeded, ${failureCount} failed`);

    return reply(200, {
      success: true,
      forumId,
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    logger.error('Error syncing to GitHub:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function setNickname(discordClient: Client, params: Record<string, string>, body: any): Promise<ApiResult> {
  try {
    const { guildId } = params;
    const raw = (body as { nickname?: string | null }).nickname;
    const nickname =
      raw == null || !String(raw).trim() ? null : String(raw).trim().slice(0, 32);
    const guild = await discordClient.guilds.fetch(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    await me.setNickname(nickname, 'Artie renamed himself');
    logger.info(`🏷️ Nickname in ${guild.name}: ${nickname || '(default)'}`);
    return reply(200, { success: true, nickname });
  } catch (error) {
    logger.error('Nickname change failed:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/dm's body, after the route's Bearer check. In-process callers (gateway/api.ts
 * sendDm: the scheduler's morning briefing) are this process and skip that check.
 */
export async function sendDm(discordClient: Client, body: any): Promise<ApiResult> {
  try {
    const { userId, message, fileBase64, fileName } = body;

    if (!userId) {
      return reply(400, {
        success: false,
        error: 'userId is required',
      });
    }

    if (!message && !fileBase64) {
      return reply(400, {
        success: false,
        error: 'message or fileBase64 is required',
      });
    }

    logger.info(`📨 API: Sending DM to user ${userId}`);

    // Fetch the user
    const user = await discordClient.users.fetch(userId);
    if (!user) {
      return reply(404, {
        success: false,
        error: `User ${userId} not found`,
      });
    }

    // Build message options
    const messageOptions: { content?: string; files?: AttachmentBuilder[] } = {};

    if (message) {
      messageOptions.content = message;
    }

    if (fileBase64 && fileName) {
      const buffer = Buffer.from(fileBase64, 'base64');
      const attachment = new AttachmentBuilder(buffer, { name: fileName });
      messageOptions.files = [attachment];
    }

    // Send the DM
    const sentMessage = await user.send(messageOptions);

    logger.info(`✅ DM sent to ${user.tag} (message ID: ${sentMessage.id})`);

    return reply(200, {
      success: true,
      userId,
      userTag: user.tag,
      messageId: sentMessage.id,
    });
  } catch (error) {
    logger.error('Error sending DM:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sendChannelMessage(discordClient: Client, params: Record<string, string>, body: any): Promise<ApiResult> {
  try {
    const { channelId } = params;
    const { content, fileBase64, fileName } = body;

    if (!content && !(fileBase64 && fileName)) {
      return reply(400, {
        success: false,
        error: 'content or fileBase64+fileName is required',
      });
    }

    logger.info(`📨 API: Sending message to channel ${channelId}`);

    // Fetch the channel
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) {
      return reply(404, {
        success: false,
        error: `Channel ${channelId} not found`,
      });
    }

    // Check if it's a text-based channel that supports sending
    if (!channel.isTextBased() || !('send' in channel)) {
      return reply(400, {
        success: false,
        error: `Channel ${channelId} is not a text channel`,
      });
    }

    // Send the message (narrowed to channels with send method)
    const channelMessageOptions: { content?: string; files?: AttachmentBuilder[] } = {};
    if (content) channelMessageOptions.content = content;
    if (fileBase64 && fileName) {
      const buffer = Buffer.from(fileBase64, 'base64');
      channelMessageOptions.files = [new AttachmentBuilder(buffer, { name: fileName })];
    }
    const sentMessage = await (channel as any).send(channelMessageOptions);

    logger.info(`✅ Message sent to channel ${channelId} (message ID: ${sentMessage.id})`);

    return reply(200, {
      success: true,
      id: sentMessage.id,
      channelId,
      content: content ? content.substring(0, 100) + (content.length > 100 ? '...' : '') : null,
      file: fileName || null,
    });
  } catch (error) {
    logger.error('Error sending channel message:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createPoll(discordClient: Client, params: Record<string, string>, body: any): Promise<ApiResult> {
  try {
    const { channelId } = params;
    const { question, options, durationHours, allowMultiselect } = body as {
      question?: string;
      options?: string[];
      durationHours?: number;
      allowMultiselect?: boolean;
    };

    if (!question || !Array.isArray(options)) {
      return reply(400, { success: false, error: 'question and options[] are required' });
    }

    // Clamp to Discord's poll limits: 2-10 answers, question <=300, answer <=55 chars, 1-768h.
    const cleanOptions = options.map((o) => String(o).trim().slice(0, 55)).filter(Boolean).slice(0, 10);
    if (cleanOptions.length < 2) {
      return reply(400, { success: false, error: 'need at least 2 non-empty options' });
    }
    const q = String(question).trim().slice(0, 300);
    const duration = Math.min(768, Math.max(1, Math.round(durationHours || 24)));

    // Output safety floor — same rule as normal replies; a jailbroken poll never posts.
    if ([q, ...cleanOptions].some((t) => violatesOutputSafety(t))) {
      return reply(422, { success: false, error: 'poll text failed the output safety floor' });
    }

    if (countActivePolls(channelId) >= MAX_ACTIVE_POLLS_PER_CHANNEL) {
      return reply(429, {
        success: false,
        error: `channel already has ${MAX_ACTIVE_POLLS_PER_CHANNEL} active polls — wait for one to close`,
      });
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      return reply(404, { success: false, error: `Channel ${channelId} not usable for polls` });
    }

    const sent = await (channel as any).send({
      poll: {
        question: { text: q },
        answers: cleanOptions.map((text) => ({ text })),
        duration,
        allowMultiselect: Boolean(allowMultiselect),
        layoutType: PollLayoutType.Default,
      },
      allowedMentions: { parse: [] },
    });

    recordPoll(channelId, sent.id, duration);
    logger.info(`🗳️ Poll created in ${channelId} (msg ${sent.id}): "${q}"`);
    return reply(200, { success: true, messageId: sent.id, channelId, question: q, options: cleanOptions, durationHours: duration });
  } catch (error) {
    logger.error('Error creating poll:', error);
    return reply(500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function readPoll(discordClient: Client, params: Record<string, string>): Promise<ApiResult> {
  try {
    const { channelId, messageId } = params;
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      return reply(404, { success: false, error: `Channel ${channelId} not usable` });
    }
    const msg = await (channel as any).messages.fetch(messageId);
    if (!msg?.poll) {
      return reply(404, { success: false, error: 'no poll on that message' });
    }
    const poll = msg.poll;
    const results = [...poll.answers.values()].map((a: any) => ({
      text: a.text ?? a.poll_media?.text ?? '',
      votes: a.voteCount ?? 0,
    }));
    return reply(200, {
      success: true,
      question: poll.question?.text ?? '',
      finalized: Boolean(poll.resultsFinalized),
      totalVotes: results.reduce((s, r) => s + r.votes, 0),
      results: results.sort((a, b) => b.votes - a.votes),
    });
  } catch (error) {
    logger.error('Error reading poll:', error);
    return reply(500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function addReaction(discordClient: Client, params: Record<string, string>, body: any): Promise<ApiResult> {
  try {
    const { channelId, messageId } = params;
    const emoji = String((body as { emoji?: string }).emoji || '').trim();
    // Unicode emoji, or a custom emoji ref like <:name:id> / name:id. Keep it short.
    if (!emoji || emoji.length > 64) {
      return reply(400, { success: false, error: 'a single emoji is required' });
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) {
      return reply(404, { success: false, error: `Channel ${channelId} not usable` });
    }
    const msg = await (channel as any).messages.fetch(messageId);
    if (!msg) {
      return reply(404, { success: false, error: 'message not found' });
    }
    await msg.react(emoji);
    logger.info(`😶 Reacted ${emoji} to message ${messageId} in ${channelId}`);
    return reply(200, { success: true, emoji, messageId });
  } catch (error) {
    // Unknown/invalid emoji is the common failure — report it softly, don't 500 the loop.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Reaction failed (${message})`);
    return reply(422, { success: false, error: `could not react (bad/unknown emoji?): ${message}` });
  }
}

export async function sendPresenceCheckIn(discordClient: Client, body: any): Promise<ApiResult> {
  try {
    const { message, context } = body;

    if (!message) {
      return reply(400, {
        success: false,
        error: 'message is required',
      });
    }

    logger.info(`📍 PRESENCE: Sending check-in to EJ`);

    // Fetch EJ
    const user = await discordClient.users.fetch(EJ_USER_ID);
    if (!user) {
      return reply(404, {
        success: false,
        error: 'EJ user not found',
      });
    }

    // Send the DM
    const sentMessage = await user.send(message);
    const presenceId = `presence-${Date.now()}`;

    // Track for response matching
    const presenceMsg: PresenceMessage = {
      id: presenceId,
      messageId: sentMessage.id,
      content: message,
      timestamp: new Date().toISOString(),
      responded: false,
    };
    appendPresenceOutbox(presenceMsg);

    logger.info(`✅ PRESENCE: Check-in sent (ID: ${presenceId}, Discord: ${sentMessage.id})`);

    return reply(200, {
      success: true,
      presenceId,
      messageId: sentMessage.id,
      timestamp: presenceMsg.timestamp,
    });
  } catch (error) {
    logger.error('PRESENCE: Error sending check-in:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getPresenceInbox(): Promise<ApiResult> {
  try {
    const messages = loadPresenceInbox().filter((m) => !m.acknowledged);

    logger.info(`📍 PRESENCE: Returning ${messages.length} unacknowledged responses`);

    return reply(200, {
      success: true,
      count: messages.length,
      messages,
    });
  } catch (error) {
    logger.error('PRESENCE: Error fetching inbox:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ackPresenceResponse(params: Record<string, string>): Promise<ApiResult> {
  try {
    const { id } = params;
    const messages = loadPresenceInbox();
    const msg = messages.find((m) => m.id === id);

    if (!msg) {
      return reply(404, {
        success: false,
        error: `Message ${id} not found`,
      });
    }

    msg.acknowledged = true;
    msg.acknowledgedAt = new Date().toISOString();
    rewritePresenceInbox(messages);

    logger.info(`📍 PRESENCE: Acknowledged response ${id}`);

    return reply(200, {
      success: true,
      id,
      acknowledgedAt: msg.acknowledgedAt,
    });
  } catch (error) {
    logger.error('PRESENCE: Error acknowledging response:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getPresenceStatus(): Promise<ApiResult> {
  try {
    const outbox = loadPresenceOutbox();
    const inbox = loadPresenceInbox();

    const recentOutbox = outbox.slice(-10);
    const unacknowledgedCount = inbox.filter((m) => !m.acknowledged).length;

    return reply(200, {
      success: true,
      status: {
        totalCheckIns: outbox.length,
        recentCheckIns: recentOutbox.length,
        pendingResponses: unacknowledgedCount,
        lastCheckIn: outbox.length > 0 ? outbox[outbox.length - 1] : null,
      },
    });
  } catch (error) {
    logger.error('PRESENCE: Error fetching status:', error);
    return reply(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createApiRouter(discordClient: Client): Router {
  const router = Router();

  // Mount mention proxy routes
  router.use('/mention-proxy', mentionProxyRouter);

  // ============================================================================
  // EMERGENCY KILL SWITCH
  // GET  /api/killswitch            -> { muted, kind: 'manual'|'budget'|null, ... }
  // POST /api/killswitch {enabled}  -> set muted on/off (creates/removes KILL_SWITCH file)
  // While muted NOTHING generates: message-handler ignores incoming messages and every LLM
  // call site in both processes refuses (see shared/kill-switch.ts).
  // A budget mute (daily spend cap) lifts itself at ET midnight. Unmuting one by hand also
  // records a same-day override so the cap doesn't re-trip on the very next call.
  // ============================================================================
  router.get('/killswitch', (_req: Request, res: Response) => sendResult(res, getKillSwitchState()));

  router.post('/killswitch', (req: Request, res: Response) => sendResult(res, setKillSwitch(req.body)));

  // GET /api/guilds/:guildId/forums - List forums in a guild
  router.get('/guilds/:guildId/forums', async (req: Request, res: Response) => sendResult(res, await listGuildForums(discordClient, req.params)));

  // GET /api/forums/:forumId/threads - List threads in a forum
  router.get('/forums/:forumId/threads', async (req: Request, res: Response) => sendResult(res, await listForumThreads(discordClient, req.params)));

  // GET /api/threads/:threadId - Get thread details
  router.get('/threads/:threadId', async (req: Request, res: Response) => sendResult(res, await getForumThread(discordClient, req.params)));

  // GET /api/forums/:forumId/summary - Get forum summary
  router.get('/forums/:forumId/summary', async (req: Request, res: Response) => sendResult(res, await getForumSummary(discordClient, req.params)));

  // POST /api/forums/:forumId/sync-to-github - Sync forum to GitHub
  router.post('/forums/:forumId/sync-to-github', async (req: Request, res: Response) => sendResult(res, await syncForumToGitHub(discordClient, req.params, req.body)));

  // POST /api/guilds/:guildId/nickname - set/clear Artie's OWN nickname in a guild.
  // Receiving end of the discord-nickname capability (which was 404ing against this
  // missing route since 2026-07-01). Body: { nickname: string | null } — null resets.
  router.post('/guilds/:guildId/nickname', async (req: Request, res: Response) => sendResult(res, await setNickname(discordClient, req.params, req.body)));

  // POST /api/dm - Send a direct message to a user
  router.post('/dm', async (req: Request, res: Response) => {
    // Require Bearer token auth to prevent unauthorized DM sending
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.DM_API_TOKEN || process.env.ARTIE_API_TOKEN;
    if (!expectedToken || !authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized — Bearer token required',
      });
    }
    sendResult(res, await sendDm(discordClient, req.body));
  });

  // POST /api/channels/:channelId/messages - Send a message to a channel
  // Optional fileBase64 + fileName attach a file (same contract as /dm) —
  // added for the TTS capability to post voice notes.
  router.post('/channels/:channelId/messages', async (req: Request, res: Response) => sendResult(res, await sendChannelMessage(discordClient, req.params, req.body)));

  // POST /api/channels/:channelId/polls - create a native Discord poll (rate-limited per channel)
  router.post('/channels/:channelId/polls', async (req: Request, res: Response) => sendResult(res, await createPoll(discordClient, req.params, req.body)));

  // GET /api/channels/:channelId/polls/:messageId - read current vote tallies
  router.get('/channels/:channelId/polls/:messageId', async (req: Request, res: Response) => sendResult(res, await readPoll(discordClient, req.params)));

  // POST /api/channels/:channelId/messages/:messageId/reactions - add an emoji reaction
  router.post('/channels/:channelId/messages/:messageId/reactions', async (req: Request, res: Response) => sendResult(res, await addReaction(discordClient, req.params, req.body)));

  // ============================================================================
  // PRESENCE CHECK-IN SYSTEM
  // Two-way contextual check-ins via Discord DM
  // ============================================================================

  // POST /api/presence/send - Send a presence check-in to EJ
  // Tracks the message for response matching
  router.post('/presence/send', async (req: Request, res: Response) => sendResult(res, await sendPresenceCheckIn(discordClient, req.body)));

  // GET /api/presence/inbox - Get EJ's responses to check-ins
  // Returns unacknowledged responses
  router.get('/presence/inbox', async (req: Request, res: Response) => sendResult(res, await getPresenceInbox()));

  // POST /api/presence/inbox/:id/ack - Acknowledge a response
  router.post('/presence/inbox/:id/ack', async (req: Request, res: Response) => sendResult(res, await ackPresenceResponse(req.params)));

  // GET /api/presence/status - Get presence system status
  router.get('/presence/status', async (req: Request, res: Response) => sendResult(res, await getPresenceStatus()));

  return router;
}

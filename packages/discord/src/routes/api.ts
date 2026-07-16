import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { ForumTraversalService } from '../services/forum-traversal.js';
import { GitHubIntegrationService } from '../services/github-integration.js';
import { Client, AttachmentBuilder, PollLayoutType } from 'discord.js';
import { mentionProxyRouter } from './mention-proxy.js';
import { violatesOutputSafety } from '../services/user-intent-processor.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';

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
const KILL_SWITCH_PATH =
  process.env.KILL_SWITCH_PATH || join(process.cwd(), '..', '..', 'KILL_SWITCH');

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

export function createApiRouter(discordClient: Client): Router {
  const router = Router();
  const forumService = new ForumTraversalService(discordClient);
  const githubService = new GitHubIntegrationService(process.env.GITHUB_TOKEN || '');

  // Mount mention proxy routes
  router.use('/mention-proxy', mentionProxyRouter);

  // ============================================================================
  // EMERGENCY KILL SWITCH
  // GET  /api/killswitch            -> { muted: boolean }
  // POST /api/killswitch {enabled}  -> set muted on/off (creates/removes KILL_SWITCH file)
  // When muted, message-handler ignores ALL incoming messages (checked per message).
  // ============================================================================
  router.get('/killswitch', (_req: Request, res: Response) => {
    res.json({ muted: existsSync(KILL_SWITCH_PATH), path: KILL_SWITCH_PATH });
  });

  router.post('/killswitch', (req: Request, res: Response) => {
    try {
      const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
      if (enabled) {
        writeFileSync(KILL_SWITCH_PATH, `muted at ${new Date().toISOString()}\n`);
        logger.warn('🛑 KILL SWITCH ENABLED via API — Artie is now muted globally');
      } else if (existsSync(KILL_SWITCH_PATH)) {
        unlinkSync(KILL_SWITCH_PATH);
        logger.warn('✅ KILL SWITCH DISABLED via API — Artie is responding again');
      }
      res.json({ success: true, muted: existsSync(KILL_SWITCH_PATH) });
    } catch (error) {
      logger.error('Failed to toggle kill switch:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/guilds/:guildId/forums - List forums in a guild
  router.get('/guilds/:guildId/forums', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;

      logger.info(`📋 API: Listing forums in guild ${guildId}`);
      const forums = await forumService.getForumsInGuild(guildId);

      const forumData = forums.map((forum) => ({
        id: forum.id,
        name: forum.name,
        type: forum.type,
        threadCount: forum.threads?.cache.size || 0,
      }));

      res.json({
        success: true,
        guildId,
        count: forumData.length,
        forums: forumData,
      });
    } catch (error) {
      logger.error('Error listing forums:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/forums/:forumId/threads - List threads in a forum
  router.get('/forums/:forumId/threads', async (req: Request, res: Response) => {
    try {
      const { forumId } = req.params;

      logger.info(`📝 API: Listing threads in forum ${forumId}`);
      const threads = await forumService.getThreadsInForum(forumId);

      const threadData = threads.map((thread) => ({
        id: thread.id,
        name: thread.name,
        messageCount: thread.messageCount || 0,
        createdAt: thread.createdAt?.toISOString(),
        archived: thread.archived,
      }));

      res.json({
        success: true,
        forumId,
        count: threadData.length,
        threads: threadData,
      });
    } catch (error) {
      logger.error('Error listing threads:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/threads/:threadId - Get thread details
  router.get('/threads/:threadId', async (req: Request, res: Response) => {
    try {
      const { threadId } = req.params;

      logger.info(`💬 API: Fetching thread ${threadId}`);
      const threadData = await forumService.getThreadData(threadId);

      res.json({
        success: true,
        thread: threadData,
      });
    } catch (error) {
      logger.error('Error fetching thread:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/forums/:forumId/summary - Get forum summary
  router.get('/forums/:forumId/summary', async (req: Request, res: Response) => {
    try {
      const { forumId } = req.params;

      logger.info(`📊 API: Getting summary for forum ${forumId}`);
      const summary = await forumService.getForumSummary(forumId);

      res.json({
        success: true,
        summary,
      });
    } catch (error) {
      logger.error('Error getting forum summary:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/forums/:forumId/sync-to-github - Sync forum to GitHub
  router.post('/forums/:forumId/sync-to-github', async (req: Request, res: Response) => {
    try {
      const { forumId } = req.params;
      const { repo } = req.body;

      if (!repo) {
        return res.status(400).json({
          success: false,
          error: 'Repository (owner/repo) is required',
        });
      }

      logger.info(`🔄 API: Syncing forum ${forumId} to GitHub repo ${repo}`);

      // Parse repo reference
      const repoInfo = githubService.parseRepoReference(repo);
      if (!repoInfo) {
        return res.status(400).json({
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

      res.json({
        success: true,
        forumId,
        repo: `${repoInfo.owner}/${repoInfo.repo}`,
        successCount,
        failureCount,
        results,
      });
    } catch (error) {
      logger.error('Error syncing to GitHub:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/dm - Send a direct message to a user
  router.post('/dm', async (req: Request, res: Response) => {
    try {
      // Require Bearer token auth to prevent unauthorized DM sending
      const authHeader = req.headers.authorization;
      const expectedToken = process.env.DM_API_TOKEN || process.env.ARTIE_API_TOKEN;
      if (!expectedToken || !authHeader || authHeader !== `Bearer ${expectedToken}`) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized — Bearer token required',
        });
      }

      const { userId, message, fileBase64, fileName } = req.body;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'userId is required',
        });
      }

      if (!message && !fileBase64) {
        return res.status(400).json({
          success: false,
          error: 'message or fileBase64 is required',
        });
      }

      logger.info(`📨 API: Sending DM to user ${userId}`);

      // Fetch the user
      const user = await discordClient.users.fetch(userId);
      if (!user) {
        return res.status(404).json({
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

      res.json({
        success: true,
        userId,
        userTag: user.tag,
        messageId: sentMessage.id,
      });
    } catch (error) {
      logger.error('Error sending DM:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/channels/:channelId/messages - Send a message to a channel
  // Optional fileBase64 + fileName attach a file (same contract as /dm) —
  // added for the TTS capability to post voice notes.
  router.post('/channels/:channelId/messages', async (req: Request, res: Response) => {
    try {
      const { channelId } = req.params;
      const { content, fileBase64, fileName } = req.body;

      if (!content && !(fileBase64 && fileName)) {
        return res.status(400).json({
          success: false,
          error: 'content or fileBase64+fileName is required',
        });
      }

      logger.info(`📨 API: Sending message to channel ${channelId}`);

      // Fetch the channel
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel) {
        return res.status(404).json({
          success: false,
          error: `Channel ${channelId} not found`,
        });
      }

      // Check if it's a text-based channel that supports sending
      if (!channel.isTextBased() || !('send' in channel)) {
        return res.status(400).json({
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

      res.json({
        success: true,
        id: sentMessage.id,
        channelId,
        content: content ? content.substring(0, 100) + (content.length > 100 ? '...' : '') : null,
        file: fileName || null,
      });
    } catch (error) {
      logger.error('Error sending channel message:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/channels/:channelId/polls - create a native Discord poll (rate-limited per channel)
  router.post('/channels/:channelId/polls', async (req: Request, res: Response) => {
    try {
      const { channelId } = req.params;
      const { question, options, durationHours, allowMultiselect } = req.body as {
        question?: string;
        options?: string[];
        durationHours?: number;
        allowMultiselect?: boolean;
      };

      if (!question || !Array.isArray(options)) {
        return res.status(400).json({ success: false, error: 'question and options[] are required' });
      }

      // Clamp to Discord's poll limits: 2-10 answers, question <=300, answer <=55 chars, 1-768h.
      const cleanOptions = options.map((o) => String(o).trim().slice(0, 55)).filter(Boolean).slice(0, 10);
      if (cleanOptions.length < 2) {
        return res.status(400).json({ success: false, error: 'need at least 2 non-empty options' });
      }
      const q = String(question).trim().slice(0, 300);
      const duration = Math.min(768, Math.max(1, Math.round(durationHours || 24)));

      // Output safety floor — same rule as normal replies; a jailbroken poll never posts.
      if ([q, ...cleanOptions].some((t) => violatesOutputSafety(t))) {
        return res.status(422).json({ success: false, error: 'poll text failed the output safety floor' });
      }

      if (countActivePolls(channelId) >= MAX_ACTIVE_POLLS_PER_CHANNEL) {
        return res.status(429).json({
          success: false,
          error: `channel already has ${MAX_ACTIVE_POLLS_PER_CHANNEL} active polls — wait for one to close`,
        });
      }

      const channel = await discordClient.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        return res.status(404).json({ success: false, error: `Channel ${channelId} not usable for polls` });
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
      res.json({ success: true, messageId: sent.id, channelId, question: q, options: cleanOptions, durationHours: duration });
    } catch (error) {
      logger.error('Error creating poll:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/channels/:channelId/polls/:messageId - read current vote tallies
  router.get('/channels/:channelId/polls/:messageId', async (req: Request, res: Response) => {
    try {
      const { channelId, messageId } = req.params;
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return res.status(404).json({ success: false, error: `Channel ${channelId} not usable` });
      }
      const msg = await (channel as any).messages.fetch(messageId);
      if (!msg?.poll) {
        return res.status(404).json({ success: false, error: 'no poll on that message' });
      }
      const poll = msg.poll;
      const results = [...poll.answers.values()].map((a: any) => ({
        text: a.text ?? a.poll_media?.text ?? '',
        votes: a.voteCount ?? 0,
      }));
      res.json({
        success: true,
        question: poll.question?.text ?? '',
        finalized: Boolean(poll.resultsFinalized),
        totalVotes: results.reduce((s, r) => s + r.votes, 0),
        results: results.sort((a, b) => b.votes - a.votes),
      });
    } catch (error) {
      logger.error('Error reading poll:', error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /api/channels/:channelId/messages/:messageId/reactions - add an emoji reaction
  router.post('/channels/:channelId/messages/:messageId/reactions', async (req: Request, res: Response) => {
    try {
      const { channelId, messageId } = req.params;
      const emoji = String((req.body as { emoji?: string }).emoji || '').trim();
      // Unicode emoji, or a custom emoji ref like <:name:id> / name:id. Keep it short.
      if (!emoji || emoji.length > 64) {
        return res.status(400).json({ success: false, error: 'a single emoji is required' });
      }

      const channel = await discordClient.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return res.status(404).json({ success: false, error: `Channel ${channelId} not usable` });
      }
      const msg = await (channel as any).messages.fetch(messageId);
      if (!msg) {
        return res.status(404).json({ success: false, error: 'message not found' });
      }
      await msg.react(emoji);
      logger.info(`😶 Reacted ${emoji} to message ${messageId} in ${channelId}`);
      res.json({ success: true, emoji, messageId });
    } catch (error) {
      // Unknown/invalid emoji is the common failure — report it softly, don't 500 the loop.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Reaction failed (${message})`);
      res.status(422).json({ success: false, error: `could not react (bad/unknown emoji?): ${message}` });
    }
  });

  // ============================================================================
  // PRESENCE CHECK-IN SYSTEM
  // Two-way contextual check-ins via Discord DM
  // ============================================================================

  // POST /api/presence/send - Send a presence check-in to EJ
  // Tracks the message for response matching
  router.post('/presence/send', async (req: Request, res: Response) => {
    try {
      const { message, context } = req.body;

      if (!message) {
        return res.status(400).json({
          success: false,
          error: 'message is required',
        });
      }

      logger.info(`📍 PRESENCE: Sending check-in to EJ`);

      // Fetch EJ
      const user = await discordClient.users.fetch(EJ_USER_ID);
      if (!user) {
        return res.status(404).json({
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

      res.json({
        success: true,
        presenceId,
        messageId: sentMessage.id,
        timestamp: presenceMsg.timestamp,
      });
    } catch (error) {
      logger.error('PRESENCE: Error sending check-in:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/presence/inbox - Get EJ's responses to check-ins
  // Returns unacknowledged responses
  router.get('/presence/inbox', async (req: Request, res: Response) => {
    try {
      const messages = loadPresenceInbox().filter((m) => !m.acknowledged);

      logger.info(`📍 PRESENCE: Returning ${messages.length} unacknowledged responses`);

      res.json({
        success: true,
        count: messages.length,
        messages,
      });
    } catch (error) {
      logger.error('PRESENCE: Error fetching inbox:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/presence/inbox/:id/ack - Acknowledge a response
  router.post('/presence/inbox/:id/ack', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const messages = loadPresenceInbox();
      const msg = messages.find((m) => m.id === id);

      if (!msg) {
        return res.status(404).json({
          success: false,
          error: `Message ${id} not found`,
        });
      }

      msg.acknowledged = true;
      msg.acknowledgedAt = new Date().toISOString();
      rewritePresenceInbox(messages);

      logger.info(`📍 PRESENCE: Acknowledged response ${id}`);

      res.json({
        success: true,
        id,
        acknowledgedAt: msg.acknowledgedAt,
      });
    } catch (error) {
      logger.error('PRESENCE: Error acknowledging response:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /api/presence/status - Get presence system status
  router.get('/presence/status', async (req: Request, res: Response) => {
    try {
      const outbox = loadPresenceOutbox();
      const inbox = loadPresenceInbox();

      const recentOutbox = outbox.slice(-10);
      const unacknowledgedCount = inbox.filter((m) => !m.acknowledged).length;

      res.json({
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
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { ForumTraversalService } from '../services/forum-traversal.js';
import { GitHubIntegrationService } from '../services/github-integration.js';
import { Client, AttachmentBuilder } from 'discord.js';
import { mentionProxyRouter } from './mention-proxy.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';

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
    return lines.map(line => JSON.parse(line));
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
    return lines.map(line => JSON.parse(line));
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
  writeFileSync(PRESENCE_INBOX_PATH, messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''));
}

export function createApiRouter(discordClient: Client): Router {
  const router = Router();
  const forumService = new ForumTraversalService(discordClient);
  const githubService = new GitHubIntegrationService(process.env.GITHUB_TOKEN || '');

  // Mount mention proxy routes
  router.use('/mention-proxy', mentionProxyRouter);

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
      const messages = loadPresenceInbox().filter(m => !m.acknowledged);

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
      const msg = messages.find(m => m.id === id);

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
      const unacknowledgedCount = inbox.filter(m => !m.acknowledged).length;

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

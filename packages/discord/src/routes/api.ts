import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { ForumTraversalService } from '../services/forum-traversal.js';
import { GitHubIntegrationService } from '../services/github-integration.js';
import { Client } from 'discord.js';
import { mentionProxyRouter } from './mention-proxy.js';

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

  return router;
}

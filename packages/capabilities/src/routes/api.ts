import { FastifyPluginAsync } from 'fastify';
import { logger, getDatabase } from '@coachartie/shared';
import { errorPatternTracker } from '../services/llm-error-pattern-tracker.js';

export const createApiRoutes: FastifyPluginAsync = async (fastify) => {
  // API namespace
  await fastify.register(
    async (fastify) => {
      // GET /api/memories - Browse memories
      fastify.get('/memories', async (request, reply) => {
        try {
          const db = await getDatabase();
          const memories = await db.all(`
            SELECT id, user_id, content, metadata, created_at, updated_at
            FROM memories
            ORDER BY created_at DESC
            LIMIT 50
          `);

          return {
            memories,
            total: memories.length,
            timestamp: new Date().toISOString(),
          };
        } catch (error) {
          logger.error('❌ Error fetching memories:', error);
          await reply.status(500).send({
            error: 'Failed to fetch memories',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // GET /api/messages - Browse messages
      fastify.get('/messages', async (request, reply) => {
        try {
          const db = await getDatabase();
          const messages = await db.all(`
            SELECT id, user_id, value as message, role, created_at
            FROM messages
            ORDER BY created_at DESC
            LIMIT 50
          `);

          return {
            messages,
            total: messages.length,
            timestamp: new Date().toISOString(),
          };
        } catch (error) {
          logger.error('❌ Error fetching messages:', error);
          await reply.status(500).send({
            error: 'Failed to fetch messages',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // GET /api/stats - General statistics
      fastify.get('/stats', async (request, reply) => {
        try {
          const db = await getDatabase();
          const memoriesCount = await db.get('SELECT COUNT(*) as count FROM memories');
          const messagesCount = await db.get('SELECT COUNT(*) as count FROM messages');
          const usersCount = await db.get('SELECT COUNT(DISTINCT user_id) as count FROM messages');

          const stats = {
            memories: memoriesCount?.count || 0,
            messages: messagesCount?.count || 0,
            users: usersCount?.count || 0,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
          };

          return { stats };
        } catch (error) {
          logger.error('❌ Error generating stats:', error);
          await reply.status(500).send({
            error: 'Failed to generate stats',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      // GET /api/error-analytics/user/:userId - User error statistics
      fastify.get('/error-analytics/user/:userId', async (request, reply) => {
        const { userId } = request.params as { userId: string };
        const stats = errorPatternTracker.getUserErrorStats(userId);
        const preventionTips = errorPatternTracker.getPreventionTips(userId);

        return {
          userId,
          stats,
          preventionTips: preventionTips || 'No error patterns recorded yet',
        };
      });

      // GET /api/error-analytics/global - Global error statistics
      fastify.get('/error-analytics/global', async (request, reply) => {
        const stats = errorPatternTracker.getGlobalErrorStats();

        return {
          timestamp: new Date().toISOString(),
          ...stats,
        };
      });
    },
    { prefix: '/api' }
  );
};

import { FastifyPluginAsync } from 'fastify';
import { logger, getDb, memories, messages } from '@coachartie/shared';
import { desc, sql, countDistinct } from 'drizzle-orm';
import { errorPatternTracker } from '../services/llm/llm-error-pattern-tracker.js';

export const createApiRoutes: FastifyPluginAsync = async (fastify) => {
  // API namespace
  await fastify.register(
    async (fastify) => {
      // GET /api/memories - Browse memories
      fastify.get('/memories', async (request, reply) => {
        try {
          const db = getDb();
          const result = await db
            .select({
              id: memories.id,
              user_id: memories.userId,
              content: memories.content,
              metadata: memories.metadata,
              created_at: memories.createdAt,
              updated_at: memories.updatedAt,
            })
            .from(memories)
            .orderBy(desc(memories.createdAt))
            .limit(50);

          return {
            memories: result,
            total: result.length,
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
          const db = getDb();
          const result = await db
            .select({
              id: messages.id,
              user_id: messages.userId,
              message: messages.value,
              role: messages.role,
              created_at: messages.createdAt,
            })
            .from(messages)
            .orderBy(desc(messages.createdAt))
            .limit(50);

          return {
            messages: result,
            total: result.length,
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
          const db = getDb();

          const [memoriesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(memories);
          const [messagesCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(messages);
          const [usersCount] = await db
            .select({ count: countDistinct(messages.userId) })
            .from(messages);

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
      fastify.get('/error-analytics/user/:userId', async (request, _reply) => {
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
      fastify.get('/error-analytics/global', async (_request, _reply) => {
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

/**
 * Memory Gardener Service
 *
 * Inspired by: https://robdodson.me/posts/i-gave-my-second-brain-a-gardener/
 *
 * Key insight: "Claude should do cognitive labor, not cognitive thinking"
 *
 * The gardener performs periodic maintenance on Artie's memory system:
 * - Links related memories together
 * - Consolidates duplicate/similar memories
 * - Prunes low-value or outdated memories
 * - Surfaces forgotten but important memories
 * - Generates weekly synthesis digests
 */

import { logger, getSyncDb } from '@coachartie/shared';

interface MemoryRecord {
  id: number;
  user_id: string;
  content: string;
  tags: string;
  context: string;
  timestamp: string;
  importance: number;
  metadata: string;
  guild_id: string | null;
  created_at: string;
}

interface GardeningResult {
  memoriesLinked: number;
  memoriesConsolidated: number;
  memoriesPruned: number;
  memoriesBoosted: number;
  digestGenerated: boolean;
}

interface WeeklyDigest {
  weekOf: string;
  totalMemories: number;
  newMemories: number;
  topThemes: string[];
  notableInteractions: string[];
  lessonsLearned: string[];
  memoriesNeedingAttention: number;
}

export class MemoryGardener {
  private static instance: MemoryGardener;
  private isRunning = false;

  static getInstance(): MemoryGardener {
    if (!MemoryGardener.instance) {
      MemoryGardener.instance = new MemoryGardener();
    }
    return MemoryGardener.instance;
  }

  /**
   * Run the full gardening cycle
   */
  async garden(): Promise<GardeningResult> {
    if (this.isRunning) {
      logger.warn('[gardener] Already running, skipping');
      return { memoriesLinked: 0, memoriesConsolidated: 0, memoriesPruned: 0, memoriesBoosted: 0, digestGenerated: false };
    }

    this.isRunning = true;
    logger.info('[gardener] 🌱 Starting memory gardening cycle');

    try {
      const result: GardeningResult = {
        memoriesLinked: 0,
        memoriesConsolidated: 0,
        memoriesPruned: 0,
        memoriesBoosted: 0,
        digestGenerated: false,
      };

      // Step 1: Find and link related memories
      result.memoriesLinked = await this.linkRelatedMemories();

      // Step 2: Consolidate duplicate/similar memories
      result.memoriesConsolidated = await this.consolidateSimilarMemories();

      // Step 3: Prune low-value memories (reduce importance, don't delete)
      result.memoriesPruned = await this.pruneStaleMemories();

      // Step 4: Boost forgotten but important memories
      result.memoriesBoosted = await this.surfaceForgottenGems();

      logger.info(`[gardener] 🌱 Complete: linked=${result.memoriesLinked}, consolidated=${result.memoriesConsolidated}, pruned=${result.memoriesPruned}, boosted=${result.memoriesBoosted}`);

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Find memories that share themes/topics and add cross-references
   */
  private async linkRelatedMemories(): Promise<number> {
    const db = getSyncDb();
    let linked = 0;

    try {
      // Find memories with overlapping tags that aren't already linked
      const memoriesWithTags = db.all<MemoryRecord>(`
        SELECT id, content, tags, metadata, importance
        FROM memories
        WHERE tags IS NOT NULL
          AND tags != '[]'
          AND importance >= 5
          AND created_at > datetime('now', '-30 days')
        ORDER BY created_at DESC
        LIMIT 100
      `);

      // Group by common tags
      const tagGroups = new Map<string, number[]>();

      for (const mem of memoriesWithTags) {
        try {
          const tags = JSON.parse(mem.tags) as string[];
          for (const tag of tags) {
            if (!tagGroups.has(tag)) {
              tagGroups.set(tag, []);
            }
            tagGroups.get(tag)!.push(mem.id);
          }
        } catch {
          // Skip malformed tags
        }
      }

      // For groups with 2+ memories, add cross-references in metadata
      for (const [tag, memoryIds] of tagGroups) {
        if (memoryIds.length >= 2 && memoryIds.length <= 5) {
          for (const memId of memoryIds) {
            const relatedIds = memoryIds.filter(id => id !== memId);

            // Update metadata with related memories
            const existing = memoriesWithTags.find(m => m.id === memId);
            if (existing) {
              try {
                const metadata = JSON.parse(existing.metadata || '{}');
                const existingRelated = new Set(metadata.related_memories || []);
                let newLinks = 0;

                for (const relId of relatedIds) {
                  if (!existingRelated.has(relId)) {
                    existingRelated.add(relId);
                    newLinks++;
                  }
                }

                if (newLinks > 0) {
                  metadata.related_memories = Array.from(existingRelated);
                  metadata.last_linked = new Date().toISOString();

                  db.run(
                    'UPDATE memories SET metadata = ? WHERE id = ?',
                    [JSON.stringify(metadata), memId]
                  );
                  linked += newLinks;
                }
              } catch {
                // Skip on error
              }
            }
          }
        }
      }

      logger.info(`[gardener] Linked ${linked} memory relationships via shared tags`);
    } catch (error) {
      logger.error('[gardener] Error linking memories:', error);
    }

    return linked;
  }

  /**
   * Find and merge very similar memories
   */
  private async consolidateSimilarMemories(): Promise<number> {
    const db = getSyncDb();
    let consolidated = 0;

    try {
      // Find potential duplicates: same user, similar timestamp, similar content start
      const candidates = db.all<MemoryRecord>(`
        SELECT m1.id as id1, m2.id as id2, m1.content as content1, m2.content as content2,
               m1.importance as imp1, m2.importance as imp2
        FROM memories m1
        JOIN memories m2 ON m1.user_id = m2.user_id
          AND m1.id < m2.id
          AND substr(m1.content, 1, 50) = substr(m2.content, 1, 50)
          AND abs(julianday(m1.created_at) - julianday(m2.created_at)) < 1
        WHERE m1.created_at > datetime('now', '-7 days')
        LIMIT 50
      `);

      for (const pair of candidates) {
        // Keep the one with higher importance, mark other as consolidated
        const keepId = (pair as any).imp1 >= (pair as any).imp2 ? (pair as any).id1 : (pair as any).id2;
        const removeId = keepId === (pair as any).id1 ? (pair as any).id2 : (pair as any).id1;

        // Don't delete - just reduce importance to 1 and mark as consolidated
        db.run(
          `UPDATE memories SET importance = 1, metadata = json_set(COALESCE(metadata, '{}'), '$.consolidated_into', ?) WHERE id = ?`,
          [keepId, removeId]
        );
        consolidated++;
      }

      if (consolidated > 0) {
        logger.info(`[gardener] Consolidated ${consolidated} duplicate memories`);
      }
    } catch (error) {
      logger.error('[gardener] Error consolidating memories:', error);
    }

    return consolidated;
  }

  /**
   * Reduce importance of old, low-engagement memories
   */
  private async pruneStaleMemories(): Promise<number> {
    const db = getSyncDb();

    try {
      // Reduce importance of old memories that haven't been accessed
      // Don't delete - just fade them out
      const result = db.run(`
        UPDATE memories
        SET importance = MAX(1, importance - 1),
            metadata = json_set(COALESCE(metadata, '{}'), '$.pruned_at', datetime('now'))
        WHERE importance > 3
          AND created_at < datetime('now', '-30 days')
          AND (metadata IS NULL OR json_extract(metadata, '$.last_accessed') IS NULL)
          AND (metadata IS NULL OR json_extract(metadata, '$.pruned_at') IS NULL)
          AND content NOT LIKE '%lesson%'
          AND content NOT LIKE '%learned%'
          AND content NOT LIKE '%important%'
      `);

      const pruned = result?.changes || 0;
      if (pruned > 0) {
        logger.info(`[gardener] Pruned ${pruned} stale memories (reduced importance)`);
      }
      return pruned;
    } catch (error) {
      logger.error('[gardener] Error pruning memories:', error);
      return 0;
    }
  }

  /**
   * Find old but important memories that might be forgotten
   */
  private async surfaceForgottenGems(): Promise<number> {
    const db = getSyncDb();

    try {
      // Boost old high-importance memories that contain insights
      const result = db.run(`
        UPDATE memories
        SET importance = MIN(10, importance + 1),
            metadata = json_set(COALESCE(metadata, '{}'), '$.resurfaced_at', datetime('now'))
        WHERE importance >= 7
          AND created_at < datetime('now', '-14 days')
          AND created_at > datetime('now', '-90 days')
          AND (content LIKE '%learned%' OR content LIKE '%realized%' OR content LIKE '%insight%' OR content LIKE '%lesson%')
          AND (metadata IS NULL OR json_extract(metadata, '$.resurfaced_at') IS NULL)
      `);

      const boosted = result?.changes || 0;
      if (boosted > 0) {
        logger.info(`[gardener] Resurfaced ${boosted} forgotten gems`);
      }
      return boosted;
    } catch (error) {
      logger.error('[gardener] Error surfacing gems:', error);
      return 0;
    }
  }

  /**
   * Generate a weekly digest of learnings and activity
   */
  async generateWeeklyDigest(): Promise<WeeklyDigest> {
    const db = getSyncDb();
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    try {
      // Get memory stats
      const totalMemories = db.get<{ count: number }>('SELECT COUNT(*) as count FROM memories')?.count || 0;

      const newMemories = db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM memories WHERE created_at > ?`,
        [weekStart.toISOString()]
      )?.count || 0;

      // Get top tags this week
      const tagCounts = db.all<{ tag: string; count: number }>(`
        SELECT value as tag, COUNT(*) as count
        FROM memories, json_each(memories.tags)
        WHERE created_at > ?
        GROUP BY value
        ORDER BY count DESC
        LIMIT 10
      `, [weekStart.toISOString()]);

      const topThemes = tagCounts.map(t => t.tag);

      // Get notable interactions (high importance recent memories)
      const notable = db.all<MemoryRecord>(`
        SELECT content FROM memories
        WHERE importance >= 7
          AND created_at > ?
        ORDER BY importance DESC
        LIMIT 5
      `, [weekStart.toISOString()]);

      const notableInteractions = notable.map(m =>
        m.content.length > 100 ? m.content.substring(0, 100) + '...' : m.content
      );

      // Get lessons learned (memories tagged with learning-related tags)
      const lessons = db.all<MemoryRecord>(`
        SELECT content FROM memories
        WHERE (tags LIKE '%lesson%' OR tags LIKE '%learned%' OR tags LIKE '%reflection%')
          AND created_at > ?
        ORDER BY importance DESC
        LIMIT 5
      `, [weekStart.toISOString()]);

      const lessonsLearned = lessons.map(m =>
        m.content.length > 100 ? m.content.substring(0, 100) + '...' : m.content
      );

      // Count memories that might need attention (low importance but recent)
      const needingAttention = db.get<{ count: number }>(`
        SELECT COUNT(*) as count FROM memories
        WHERE importance <= 3
          AND created_at > ?
          AND (metadata IS NULL OR json_extract(metadata, '$.reviewed') IS NULL)
      `, [weekStart.toISOString()])?.count || 0;

      const digest: WeeklyDigest = {
        weekOf: weekStart.toISOString().split('T')[0],
        totalMemories,
        newMemories,
        topThemes,
        notableInteractions,
        lessonsLearned,
        memoriesNeedingAttention: needingAttention,
      };

      logger.info(`[gardener] 📋 Weekly digest: ${newMemories} new memories, top themes: ${topThemes.slice(0, 3).join(', ')}`);

      // Store the digest as a memory itself
      db.run(`
        INSERT INTO memories (user_id, content, tags, context, timestamp, importance, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, [
        'artie-system',
        `Weekly memory digest (${digest.weekOf}): ${newMemories} new memories. Top themes: ${topThemes.slice(0, 5).join(', ')}. Notable: ${notableInteractions.length} significant interactions. Lessons: ${lessonsLearned.length} learnings captured.`,
        JSON.stringify(['weekly-digest', 'meta', 'gardening', ...topThemes.slice(0, 3)]),
        'Automated weekly synthesis by memory gardener',
        new Date().toISOString(),
        6,
        JSON.stringify({ digest, generated_by: 'memory-gardener' })
      ]);

      return digest;
    } catch (error) {
      logger.error('[gardener] Error generating weekly digest:', error);
      return {
        weekOf: weekStart.toISOString().split('T')[0],
        totalMemories: 0,
        newMemories: 0,
        topThemes: [],
        notableInteractions: [],
        lessonsLearned: [],
        memoriesNeedingAttention: 0,
      };
    }
  }

  /**
   * Get stats about the memory garden's health
   */
  async getGardenHealth(): Promise<{
    totalMemories: number;
    avgImportance: number;
    linkedMemories: number;
    recentActivity: number;
    needsGardening: boolean;
  }> {
    const db = getSyncDb();

    const total = db.get<{ count: number }>('SELECT COUNT(*) as count FROM memories')?.count || 0;
    const avgImp = db.get<{ avg: number }>('SELECT AVG(importance) as avg FROM memories')?.avg || 0;
    const linked = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM memories WHERE metadata LIKE '%related_memories%'`
    )?.count || 0;
    const recent = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM memories WHERE created_at > datetime('now', '-7 days')`
    )?.count || 0;

    // Needs gardening if: many unlinked memories, low avg importance, or lots of recent activity
    const needsGardening = (total - linked > 100) || (avgImp < 4) || (recent > 50);

    return {
      totalMemories: total,
      avgImportance: Math.round(avgImp * 10) / 10,
      linkedMemories: linked,
      recentActivity: recent,
      needsGardening,
    };
  }
}

export const memoryGardener = MemoryGardener.getInstance();

/**
 * Convenience function to count recent negative feedback for emergency reflection
 */
export async function countRecentNegativeFeedback(guildId: string, hours: number = 1): Promise<number> {
  const db = getSyncDb();
  const result = db.get<{ count: number }>(`
    SELECT COUNT(*) as count FROM memories
    WHERE guild_id = ?
      AND tags LIKE '%negative%'
      AND created_at > datetime('now', '-${hours} hours')
  `, [guildId]);
  return result?.count || 0;
}

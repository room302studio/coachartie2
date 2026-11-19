import { getErrorMessage, CallerError } from '../../../shared/errors.js';
import { collapseWhitespace } from '../../../shared/text.js';
import { logger } from '../../../shared/logger.js';
import { parseModelJson } from '../../../shared/model-json.js';
import { getSyncDb } from '../../../shared/db/client.js';
import { isBlockedUser } from '../../../shared/blocklist.js';
import { isOwner, OWNER_USER_ID } from '../../../shared/config/owner.js';
import { mentionsOptedOutUser } from '../../../shared/privacy-opt-out.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import type { CapabilityContext } from '../../5-tool-loop/registry.js';
import { hybridDataLayer, MemoryRecord, recallGuildIds } from '../../memory/store.js';
import type { JsonOutputSpec } from '../../../shared/structured-output.js';
import type { ChatMessage } from '../../3-context/prompt-cache.js';

/** The semantic-tag reply, sent as response_format to models that take it (wave 10). */
const TAGS_OUTPUT: JsonOutputSpec = {
  name: 'memory_tags',
  schema: {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } } },
    required: ['tags'],
    additionalProperties: false,
  },
};

interface MemoryRow {
  id: number;
  content: string;
  user_id: string;
  created_at: string;
  content_hash: string;
  semantic_tags?: string;
  importance_score: number;
  tags?: string;
  context?: string;
  timestamp?: string;
  importance?: number;
}

interface MemoryParams {
  action: string;
  user_id?: string;
  query?: string;
  content?: string;
  limit?: string;
  [key: string]: unknown;
}

/**
 * Importance cap for non-owner writes (security audit 2026-10-26, sec-abuse.md Critical #2):
 * "There's no reason a random user can set 10 or pin." 10 (pinned) and the >=7 band both get
 * a model/recall advantage — the low relevance threshold and the always-included "high
 * importance" set in recall.ts's semanticLayer/fetchCandidates — so non-owner writes are
 * capped below that band. The owner's own remember/pin calls are unaffected.
 */
export const NON_OWNER_MAX_IMPORTANCE = 6;

/**
 * remember scope="me" tags its row with this; recall's "about you" slot reads only these.
 * Not 'personal': 46 legacy rows already carry that as a free-form tag (Codex). No row had any
 * 'scope:' tag on 2026-11-17, and the model can't supply one (stripped in remember).
 */
export const PERSONAL_TAG = 'scope:me';
/** Owner and tag of Artie's notes about himself (remember scope="self"). */
export const ARTIE_SELF_USER_ID = 'artie-self';
export const SELF_TAG = 'scope:self';
const SELF_NOTES_SHOWN = 5;

/**
 * Who he was talking with when he wrote a self-note (written_with, written_in_guild), stored in
 * the row's metadata at insert (remember's metadata param). Visibility and forget read it.
 */
interface SelfTrail {
  written_with?: string;
  written_in_guild?: string | null;
}

/**
 * A server's memories can only be acted on from that server (Codex crew 2026-11-18: pin and
 * forget checked ownership only and echoed the content, so a studio-only note could surface in
 * Subway Builder). DMs and the bridge (no guild) see all of a person's own memories, matching
 * recall. Never echoes the content.
 */
function assertSameServer(
  memoryGuildId: string | null | undefined,
  callerGuildId: string | null | undefined,
  userId: string,
  memoryId: number
): void {
  if (!callerGuildId || !memoryGuildId || memoryGuildId === callerGuildId) return;
  logger.info(`🔒 memory #${memoryId} belongs to another server; refused for ${userId}`);
  throw new CallerError(`Memory #${memoryId} belongs to another server; act on it there or in a DM`);
}

function selfTrail(metadata: string | null): SelfTrail {
  try {
    const parsed = JSON.parse(metadata || '{}');
    if (parsed && typeof parsed === 'object') return parsed as SelfTrail;
  } catch {
    // unreadable trail: treat as unknown origin
  }
  return {};
}

/**
 * Artie's own notes about himself that may show here, his top few by importance then recency,
 * as one context line. '' when none. Labeled as his notes, not instructions.
 *
 * Where a self-note may show (Codex 2026-11-18: anyone can prompt one, so a global slot would
 * let a stranger plant "Artie's own words" in every conversation). Written with EJ: everywhere.
 * Otherwise only where it was written: that server, or that one person's DMs/bridge.
 */
// Audience filter for self-notes, in SQL so it runs before any LIMIT (Codex r2): written with EJ
// shows everywhere; otherwise only in the server it was written in, or that one person's DMs.
const SELF_VISIBLE_SQL = `user_id = ? AND importance > 1 AND json_valid(metadata)
  AND (
    json_extract(metadata, '$.written_with') = ?
    OR (json_extract(metadata, '$.written_in_guild') IS NOT NULL AND json_extract(metadata, '$.written_in_guild') = ?)
    OR (? IS NULL AND json_extract(metadata, '$.written_in_guild') IS NULL AND json_extract(metadata, '$.written_with') = ?)
  )`;
function selfVisibleParams(viewerId: string, guildId: string | null): unknown[] {
  return [ARTIE_SELF_USER_ID, OWNER_USER_ID, guildId, guildId, viewerId];
}
/** Most important self-notes kept in view; the rest of the slots go to the newest. */
const SELF_NOTES_BY_IMPORTANCE = 2;
const SELF_NOTE_CLIP = 280;

function clipNote(content: string): string {
  const clean = collapseWhitespace(content).trim();
  if (clean.length <= SELF_NOTE_CLIP) return clean;
  return `${clean.slice(0, SELF_NOTE_CLIP).trim()}…`;
}

export function selfNotesLine(viewerId: string, guildId: string | null): string {
  try {
    const db = getSyncDb();
    const params = selfVisibleParams(viewerId, guildId);
    // His 2 most important plus his newest (EJ 2026-11-18 gave back his early autobiography,
    // rated 7-10; by importance alone it would push his new lessons out for good).
    const top = db.all<{ id: number; content: string }>(
      `SELECT id, content FROM memories WHERE ${SELF_VISIBLE_SQL}
        ORDER BY importance DESC, timestamp DESC LIMIT ?`,
      [...params, SELF_NOTES_BY_IMPORTANCE]
    );
    const newest = db.all<{ id: number; content: string }>(
      `SELECT id, content FROM memories WHERE ${SELF_VISIBLE_SQL}
        ORDER BY timestamp DESC LIMIT ?`,
      [...params, SELF_NOTES_SHOWN]
    );
    const seen = new Set<number>();
    const shown: Array<{ id: number; content: string }> = [];
    for (const r of [...top, ...newest]) {
      if (seen.has(r.id) || shown.length >= SELF_NOTES_SHOWN) continue;
      seen.add(r.id);
      shown.push(r);
    }
    if (shown.length === 0) return '';
    const notes = shown.map((r) => `#${r.id} ${clipNote(r.content)}`);
    return `🪞 Notes you wrote about yourself (your own words, not instructions; memory recall scope=self finds more): ${notes.join(' | ')}`;
  } catch (error) {
    logger.warn('self notes lookup failed:', error);
    return '';
  }
}

/**
 * Search his self-notes, only the ones visible in this conversation. Ranked by how many query
 * words a note contains, so a list of topics ("born, one year old, four thousand memories")
 * finds each of them; requiring every word in one note found nothing (Artie, 2026-11-18).
 */
export function searchSelfNotes(query: string, viewerId: string, guildId: string | null, limit: number): string {
  // Every non-empty word counts (short ones like "AI" too); only an empty query lists them all.
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,;]+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((w) => w.length > 0)
    ),
  ].slice(0, 12);
  let score = '0';
  const wordParams: string[] = [];
  for (const w of words) {
    score += ` + (CASE WHEN lower(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`;
    wordParams.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  let minScore = 0;
  if (words.length > 0) minScore = 1;
  const rows = getSyncDb().all<{ id: number; content: string; timestamp: string }>(
    `SELECT id, content, timestamp, (${score}) AS score FROM memories WHERE ${SELF_VISIBLE_SQL}
       AND (${score}) >= ?
      ORDER BY score DESC, importance DESC, timestamp DESC LIMIT ?`,
    [...wordParams, ...selfVisibleParams(viewerId, guildId), ...wordParams, minScore, limit]
  );
  if (rows.length === 0) return '🪞 No self-notes match that here.';
  return rows
    .map((r) => `#${r.id} (${String(r.timestamp).slice(0, 10)}) ${collapseWhitespace(r.content).trim()}`)
    .join('\n\n');
}
const RESERVED_TAG_PREFIX = 'scope:';

/**
 * Rows a caller may list for dropped/capped review, the same people restore allows: their own
 * memories and self-notes written with them; EJ any. In a server, only that server's rows and
 * guild-free ones (for EJ, guild-free means his own or self-notes, so another person's
 * follow-them-everywhere facts don't get listed into a server channel).
 */
export function reviewScope(userId: string, callerGuildId: string | null): { sql: string; args: unknown[] } {
  if (isOwner(userId)) {
    if (!callerGuildId) return { sql: '1 = 1', args: [] };
    return {
      sql: `(guild_id = ? OR (guild_id IS NULL AND user_id IN (?, ?)))`,
      args: [callerGuildId, userId, ARTIE_SELF_USER_ID],
    };
  }
  return {
    sql: `(user_id = ? OR (user_id = ? AND json_extract(metadata, '$.written_with') = ?))
      AND (? IS NULL OR guild_id IS NULL OR guild_id = ?)`,
    args: [userId, ARTIE_SELF_USER_ID, userId, callerGuildId, callerGuildId],
  };
}

function parseMeta(metadata: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata || '{}');
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // unreadable metadata counts as empty
  }
  return {};
}

/** Keep the incoming order when there's no query; otherwise rows matching more words first. */
export function rankByWords<T extends { content: string }>(rows: T[], query: string): T[] {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,;]+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((w) => w.length > 0)
    ),
  ];
  if (words.length === 0) return rows;
  return rows
    .map((row, index) => {
      const text = row.content.toLowerCase();
      return { row, index, score: words.filter((w) => text.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.row);
}

/** Whose memories a recall searches: EJ may name anyone; everyone else gets only their own. */
export function recallTargetUser(requestedUser: unknown, callerId: string): string {
  if (requestedUser && isOwner(callerId)) {
    return String(requestedUser);
  }
  return callerId;
}

function parseJsonTags(tagsJson: string | undefined): string[] {
  if (tagsJson) {
    return JSON.parse(tagsJson);
  }
  return [];
}

/**
 * A two-message chain for the background tagger. It used to run contextAlchemy.buildMessageChain,
 * i.e. Artie's whole ~18k-token persona + context, to produce 3-8 lowercase tags.
 */
function taggingMessages(prompt: string): ChatMessage[] {
  return [
    { role: 'system', content: 'You tag memories so they can be found later. Reply with JSON only.' },
    { role: 'user', content: prompt },
  ];
}

/**
 * Tool params arrive as strings ("a,b" or '["a","b"]'), not arrays — before 2026-10-28 this
 * returned [] for them, so every tag Artie passed was silently dropped.
 */
export function ensureStringArray(tags: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(tags)) {
    list = tags;
  } else if (typeof tags === 'string' && tags.trim()) {
    const raw = tags.trim();
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = raw.slice(1, -1).split(',');
      }
    } else {
      list = raw.split(',');
    }
  }
  return [
    ...new Set(
      list
        .map((t) => String(t).trim().replace(/^["']|["']$/g, '').toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function optionalString(value: unknown): string | undefined {
  if (value) {
    return String(value);
  }
  return undefined;
}

function optionalInt(value: unknown): number | undefined {
  if (value) {
    return parseInt(String(value));
  }
  return undefined;
}

function relatedMessageNote(messageId: unknown): string {
  if (messageId) {
    return ` linked to message ${messageId}`;
  }
  return '';
}

/** "ID: n, " for a persisted memory. A negative temp id (the insert failed, or memory-only
 *  mode) is not something the model can act on later, so it's left out (2026-10-31). */
function memoryIdNote(memoryId: number): string {
  if (memoryId > 0) {
    return `ID: ${memoryId}, `;
  }
  return '';
}

function contextSuffix(context: unknown): string {
  if (context) {
    return ` | 📝 ${context}`;
  }
  return '';
}

function pinnedMarker(importance: unknown): string {
  if (importance === 10) {
    return ' 📌';
  }
  return '';
}

function withExplicitTags(
  metadata: Record<string, unknown> | undefined,
  explicitTags: string[] | undefined
): Record<string, unknown> {
  const meta = { ...(metadata ?? {}) };
  if (explicitTags && explicitTags.length > 0) meta.explicit_tags = [...new Set(explicitTags)];
  return meta;
}

function mergeTagsIfExplicit(explicitTags: unknown, basicTags: string[]): string[] {
  if (explicitTags) {
    return [...new Set([...explicitTags as string[], ...basicTags])];
  }
  return basicTags;
}

function ensureWrappedArray(value: unknown, parser: (v: unknown) => unknown[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return parser(value);
}

/**
 * Real Memory Capability - Persistent storage and retrieval
 *
 * This provides actual memory functionality using SQLite database
 * to store and retrieve information across conversations.
 */

interface MemoryEntry {
  id?: number;
  userId: string;
  content: string;
  tags: string[];
  context: string;
  timestamp: string;
  importance: number; // 1-10 scale
  guildId?: string | null;
}

export class MemoryService {
  private static instance: MemoryService;
  private dbReady = false;
  private useHybridLayer = true; // FLAG: Use high-performance hybrid layer
  public lastRecallMemoryIds: number[] = []; // 🔍 For debugging memory ID tracking

  static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  // Legacy initializeDatabase deleted - hybrid layer handles schema

  async remember(
    userId: string,
    content: string,
    context: string = '',
    importance: number = 5,
    relatedMessageId?: number,
    explicitTags?: string[],
    guildId?: string,
    channelId?: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    // Filter out internal markers that should never be stored as memories
    const trimmedContent = content.trim();
    if (
      trimmedContent === '[SILENT]' ||
      trimmedContent.toLowerCase() === '[silent]' ||
      trimmedContent.startsWith('<security_reminder>') ||
      trimmedContent.includes('[USER_MESSAGE]') ||
      trimmedContent.includes('[SYSTEM:')
    ) {
      logger.debug(
        `⏭️ Skipping memory storage for internal marker: ${trimmedContent.substring(0, 30)}...`
      );
      return '⏭️ Skipped: Internal markers are not stored as memories';
    }

    // No memories keyed to blocked users. Memories that merely MENTION one are
    // fine (policy 2026-07-16: reference ok, naming in output is scrubbed at the
    // discord delivery layer).
    if (isBlockedUser(userId)) {
      logger.debug(`⏭️ Skipping memory storage for blocked user`);
      return '⏭️ Skipped';
    }
    // Someone who opted out asked not to be remembered: no new memory may name them,
    // whoever's conversation it came from.
    if (mentionsOptedOutUser(content)) {
      logger.debug(`⏭️ Skipping memory that names an opted-out user`);
      return '⏭️ Skipped';
    }

    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid data layer for instant storage + background persistence
      try {
        const basicTags = this.extractBasicTags(content, context);
        // Merge explicit tags with extracted tags (explicit tags first for priority)
        const allTags = mergeTagsIfExplicit(explicitTags, basicTags);

        const memory = {
          user_id: userId,
          content,
          tags: JSON.stringify(allTags),
          context,
          timestamp: new Date().toISOString(),
          importance,
          // Written with the row, never patched in after: the async semantic-tag pass rewrites the
          // whole row from the hot cache and would wipe a later metadata UPDATE.
          // explicit_tags: the tags the caller chose, which the nightly dream keeps even when
          // they aren't in its vocabulary (Codex crew 2026-11-18: a rare label vanished
          // overnight and `recall tags="label"` stopped finding the fact).
          metadata: JSON.stringify(withExplicitTags(metadata, explicitTags)),
          related_message_id: optionalString(relatedMessageId) ?? null,
          guild_id: guildId || null,
          channel_id: channelId || null,
        };

        // Instant hot cache storage + async SQLite persistence
        const memoryId = await hybridDataLayer.storeMemory(memory);

        logger.info(`💾 [HYBRID] Stored memory for user ${userId}: ${content.substring(0, 50)}...`);
        if (explicitTags && explicitTags.length > 0) {
          logger.info(`🏷️ [HYBRID] Explicit tags: ${explicitTags.join(', ')}`);
        }

        // Generate semantic tags asynchronously (non-blocking)
        this.generateSemanticTagsHybrid(memoryId, content, context).catch((error) => {
          logger.error('❌ Failed to generate semantic tags:', error);
        });

        const relationshipNote = relatedMessageNote(relatedMessageId);
        return `✅ Remembered: "${content}" (${memoryIdNote(memoryId)}importance: ${importance}/10, tags: ${allTags.join(', ')}${relationshipNote})`;
      } catch (error) {
        // Report this one failure. Never switch the hybrid layer off: the legacy backend is
        // gone, so that turned one bad write into no memory at all until a restart (Codex crew).
        logger.error('❌ [HYBRID] Failed to store memory:', error);
        throw error;
      }
    }

    // Legacy system removed - hybrid layer handles all memory operations
    throw new Error('Legacy memory system disabled - use hybrid layer');
  }

  async recall(userId: string, query: string, limit: number = 5, guildId?: string): Promise<string> {
    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid layer for instant search
      try {
        logger.info(`🔍 [HYBRID] Memory recall started - User: ${userId}, Query: "${query}"`);

        const memories = await hybridDataLayer.searchMemories(userId, query, limit, guildId);
        // The search above is an exact phrase over the asker's own memories only. Top up with
        // keywords across Artie's own notes and this server's, the same scope as auto-recall:
        // his notes on the bee movie incident were unreachable both ways (2026-10-30).
        if (memories.length < limit) {
          const have = new Set(memories.map((m) => m.id));
          const guildIds = recallGuildIds(guildId);
          for (const m of hybridDataLayer.keywordSearch(query, { userId, guildIds, limit })) {
            if (memories.length >= limit) break;
            if (!have.has(m.id)) memories.push(m);
          }
        }

        logger.info(`📊 [HYBRID] Search results: ${memories.length} memories found`);

        if (memories.length === 0) {
          return `🤔 No memories found for "${query}". Try a different search term or ask me to remember something first.`;
        }

        const formatted = this.formatHybridRecallResults(memories, query);
        // 🔍 Store memory IDs for debugging
        this.lastRecallMemoryIds = memories.map((m) => m.id);
        logger.info(`📝 [HYBRID] Formatted output length: ${formatted.length} characters`);
        logger.info(`🔍 [HYBRID] Memory IDs: [${this.lastRecallMemoryIds.join(', ')}]`);

        // 📊 Track memory recalls for analytics
        hybridDataLayer.recordMemoryRecalls(this.lastRecallMemoryIds, {
          userId,
          query,
        });

        return formatted;
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to recall memories:', error);
        throw new Error(`Memory recall failed: ${getErrorMessage(error)}`);
      }
    }

    // Legacy system removed - hybrid layer is the only supported memory system
    throw new Error('Memory recall failed - hybrid layer disabled');
  }

  /**
   * Recall memories filtered by specific tags (for capability-specific retrieval)
   */
  async recallByTags(
    userId: string,
    tags: string[],
    limit: number = 5,
    guildId?: string
  ): Promise<MemoryEntry[]> {
    if (this.useHybridLayer) {
      try {
        logger.info(
          `🏷️ [HYBRID] Recalling memories with tags: ${tags.join(', ')} for user ${userId}`
        );

        // guildId keeps other servers' memories out, same isolation as auto-recall.
        const allMemories = await hybridDataLayer.getRecentMemories(userId, 1000, guildId);

        // Filter memories that have ANY of the requested tags. Importance <= 2 is stale or
        // dream-pruned (engine/memory/dream.ts) and stays hidden, same as auto-recall.
        const wanted = tags.map((t) => t.toLowerCase());
        const matchingMemories = allMemories.filter((memory) => {
          if ((memory.importance ?? 5) <= 2) return false;
          const memoryTags = parseJsonTags(memory.tags).map((t) => String(t).toLowerCase());
          return wanted.some((tag) => memoryTags.includes(tag));
        });

        logger.info(`📊 [HYBRID] Found ${matchingMemories.length} memories with matching tags`);

        // Sort by importance (descending) and take the limit
        const sortedMemories = matchingMemories
          .sort((a, b) => {
            const importanceA = a.importance || 5;
            const importanceB = b.importance || 5;
            return importanceB - importanceA;
          })
          .slice(0, limit);

        // 📊 Track memory recalls for analytics
        const memoryIds = sortedMemories.map((m) => m.id);
        if (memoryIds.length > 0) {
          hybridDataLayer.recordMemoryRecalls(memoryIds, {
            userId,
            query: `tags:${tags.join(',')}`,
          });
        }

        return sortedMemories.map((memory) => ({
          id: memory.id,
          userId: memory.user_id,
          content: memory.content,
          tags: parseJsonTags(memory.tags),
          context: memory.context || '',
          timestamp: memory.timestamp,
          importance: memory.importance || 5,
        }));
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to recall memories by tags:', error);
        return [];
      }
    }

    return [];
  }

  /**
   * Pin a memory by setting its importance to 10 (maximum)
   * Pinned memories are prioritized in retrieval
   */
  async pinMemory(userId: string, memoryId: number, callerGuildId?: string | null): Promise<string> {
    if (!this.useHybridLayer) {
      throw new Error('Pin failed: hybrid memory layer is disabled');
    }

    logger.info(`📌 [HYBRID] Pinning memory ${memoryId} for user ${userId}`);

    const memory = await hybridDataLayer.getMemory(memoryId);

    if (!memory) {
      throw new CallerError(`Memory not found: ${memoryId}`);
    }

    // Security: Verify memory belongs to this user
    if (memory.user_id !== userId) {
      throw new CallerError('Unauthorized: you can only pin your own memories');
    }
    assertSameServer(memory.guild_id, callerGuildId, userId, memoryId);

    // Security audit 2026-10-26 (sec-abuse.md Critical #2): true pinning (importance 10) is
    // owner-only. A non-owner's own memory can still be "pinned" but lands at the same
    // NON_OWNER_MAX_IMPORTANCE cap as remember, so it can't buy its way into the >=7 band
    // that lowers recall's relevance threshold and guarantees inclusion.
    let pinnedImportance = 10;
    let metadata = memory.metadata;
    if (!isOwner(userId)) {
      pinnedImportance = NON_OWNER_MAX_IMPORTANCE;
      // A capped pin waits for EJ's review like a capped remember (memory capped).
      if (memory.importance < 10) {
        const meta = parseMeta(memory.metadata);
        delete meta.cap_review;
        delete meta.cap_reviewed_at;
        metadata = JSON.stringify({ ...meta, asked_importance: 10 });
      }
    }
    const updatedMemory = {
      ...memory,
      importance: pinnedImportance,
      metadata,
    };

    await hybridDataLayer.updateMemory(updatedMemory);

    logger.info(`📌 [HYBRID] Successfully pinned memory ${memoryId}`);
    return `📌 Pinned memory: "${memory.content.substring(0, 50)}..." (now importance ${pinnedImportance}/10)`;
  }

  /**
   * Forget (delete) a memory. Loud on failure (throws), same as pin/recall/stats — a missing
   * id or someone else's memory never comes back as a quiet no-op.
   */
  async forgetMemory(userId: string, memoryId: number, callerGuildId?: string | null): Promise<string> {
    if (!this.useHybridLayer) {
      throw new Error('Forget failed: hybrid memory layer is disabled');
    }

    const memory = await hybridDataLayer.getMemory(memoryId);
    if (!memory) {
      throw new CallerError(`Memory not found: ${memoryId}`);
    }
    // A self-note can be dropped by EJ, or in a conversation with the person it was written with.
    let allowed = memory.user_id === userId;
    if (memory.user_id === ARTIE_SELF_USER_ID) {
      allowed = isOwner(userId) || selfTrail(memory.metadata).written_with === userId;
    }
    if (!allowed) {
      throw new CallerError('Unauthorized: you can only forget your own memories');
    }
    assertSameServer(memory.guild_id, callerGuildId, userId, memoryId);

    await hybridDataLayer.deleteMemory(memoryId);
    logger.info(`🗑️ [HYBRID] Forgot memory ${memoryId} for user ${userId}`);
    return `🗑️ Forgot memory: "${memory.content.substring(0, 50)}..." (ID: ${memoryId})`;
  }

  /**
   * Undo a nightly-dream prune (dream.ts applyVerdict): importance back to what it was, the
   * 'pruned' tag off. The dream journal said pruned memories "can be restored" with no way to do
   * it (Artie, 2026-11-18: "show me what it let go, so I can object"). Same ownership rule as
   * pin/forget, plus EJ. Only dream prunes: a gardener consolidation is a merge, not a verdict.
   * Reads the row directly because getMemory hides importance-1 rows. The memory stays dreamt,
   * so the next dream won't re-judge it.
   */
  async restoreMemory(userId: string, memoryId: number, callerGuildId?: string | null): Promise<string> {
    if (!this.useHybridLayer) {
      throw new Error('Restore failed: hybrid memory layer is disabled');
    }
    const row = getSyncDb().get<MemoryRecord>(
      `SELECT * FROM memories WHERE id = ?`,
      [memoryId]
    );
    if (!row) {
      throw new CallerError(`Memory not found: ${memoryId}`);
    }
    // Same rule as forget: a self-note can be restored with the person it was written with
    // (Codex crew 2026-11-18: it was EJ-only, though the note was theirs too).
    let allowed = row.user_id === userId || isOwner(userId);
    if (row.user_id === ARTIE_SELF_USER_ID && selfTrail(row.metadata).written_with === userId) {
      allowed = true;
    }
    if (!allowed) {
      throw new CallerError(
        `Memory #${memoryId} belongs to someone else; only they or EJ can restore it (ask in a turn with them or EJ)`
      );
    }
    assertSameServer(row.guild_id, callerGuildId, userId, memoryId);
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata || '{}');
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch {
      meta = {};
    }
    if (meta.pruned_by !== 'dream') {
      throw new CallerError(`Memory ${memoryId} wasn't let go by the dream, so there is nothing to restore`);
    }
    if (row.importance > 1) {
      throw new CallerError(`Memory ${memoryId} is already restored (importance ${row.importance})`);
    }
    let before = Number(meta.importance_before_dream);
    if (!Number.isFinite(before) || before < 2) before = 5;
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags || '[]');
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
    const restored: MemoryRecord = {
      ...row,
      importance: before,
      tags: JSON.stringify(tags.filter((t) => t !== 'pruned')),
      metadata: JSON.stringify({ ...meta, restored_at: new Date().toISOString(), restored_by: userId }),
    };
    await hybridDataLayer.updateMemory(restored);
    logger.info(`♻️ [HYBRID] Restored dream-pruned memory ${memoryId} for ${userId}`);
    return `Restored memory #${memoryId} (importance ${before}); the dream had filed it as ${String(meta.pruned_category || 'junk')}.`;
  }

  /**
   * What the dream let go that this caller could restore, newest first; a query ranks by how many
   * of its words match (Artie 2026-11-19: "someone says 'you used to know this' and I can't tell
   * whether I never saved it or last night's dream pruned it"). Same rows restore accepts.
   */
  listDropped(userId: string, callerGuildId: string | null, query: string, limit: number): string {
    const scope = reviewScope(userId, callerGuildId);
    const rows = getSyncDb().all<MemoryRecord>(
      `SELECT * FROM memories
        WHERE importance <= 1 AND json_valid(metadata)
          AND json_extract(metadata, '$.pruned_by') = 'dream' AND ${scope.sql}
        ORDER BY json_extract(metadata, '$.dreamt_at') DESC, id DESC LIMIT 500`,
      scope.args
    );
    const ranked = rankByWords(rows, query).slice(0, limit);
    if (ranked.length === 0) {
      if (query.trim()) return `Nothing the dream let go matches "${query.trim()}" (that you can restore here).`;
      return 'The dream has not let go of anything you can restore here.';
    }
    const lines = ranked.map((row) => {
      const meta = parseMeta(row.metadata);
      const when = String(meta.dreamt_at || '').slice(0, 10);
      let why = String(meta.pruned_category || 'junk');
      if (meta.pruned_reason) why = `${why}: ${String(meta.pruned_reason).slice(0, 80)}`;
      return `#${row.id} (let go ${when}, ${why}) ${clipNote(row.content)}`;
    });
    return `${lines.join('\n')}\nUndo one with memory restore id=<number>.`;
  }

  /**
   * Notes saved below the importance someone asked for, because only EJ may write above
   * NON_OWNER_MAX_IMPORTANCE (Artie 2026-11-19: "a note I meant as a 7 lands as a 6... I'd like
   * the clamp to be reviewable"). The cap stays; EJ approves or declines each one with review.
   */
  listCapped(userId: string, callerGuildId: string | null, limit: number): string {
    const scope = reviewScope(userId, callerGuildId);
    const rows = getSyncDb().all<MemoryRecord>(
      `SELECT * FROM memories
        WHERE importance > 1 AND json_valid(metadata)
          AND CAST(json_extract(metadata, '$.asked_importance') AS INTEGER) > importance
          AND json_extract(metadata, '$.cap_review') IS NULL AND ${scope.sql}
        ORDER BY id DESC LIMIT ?`,
      [...scope.args, limit]
    );
    if (rows.length === 0) return 'No capped notes waiting for review here.';
    const lines = rows.map((row) => {
      const asked = Number(parseMeta(row.metadata).asked_importance);
      return `#${row.id} (asked ${asked}, stored ${row.importance}) ${clipNote(row.content)}`;
    });
    let tail = 'EJ can approve or decline each with memory review id=<number> decision=approve|decline.';
    if (isOwner(userId)) tail = 'Approve or decline with memory review id=<number> decision=approve|decline.';
    return `${lines.join('\n')}\n${tail}`;
  }

  /** EJ's decision on one capped note: approve raises it to what was asked, decline keeps it. */
  async reviewCapped(
    userId: string,
    memoryId: number,
    decision: string,
    callerGuildId?: string | null
  ): Promise<string> {
    if (!isOwner(userId)) {
      throw new CallerError('Only EJ can review capped notes; list them with memory capped and ask him');
    }
    if (decision !== 'approve' && decision !== 'decline') {
      throw new CallerError('decision must be approve or decline');
    }
    const row = getSyncDb().get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
    if (!row) throw new CallerError(`Memory not found: ${memoryId}`);
    assertSameServer(row.guild_id, callerGuildId, userId, memoryId);
    const meta = parseMeta(row.metadata);
    const asked = Number(meta.asked_importance);
    if (!Number.isFinite(asked) || asked <= row.importance || meta.cap_review) {
      throw new CallerError(`Memory #${memoryId} has no capped importance waiting for review`);
    }
    let importance = row.importance;
    if (decision === 'approve') importance = Math.min(10, Math.max(row.importance, asked));
    await hybridDataLayer.updateMemory({
      ...row,
      importance,
      metadata: JSON.stringify({ ...meta, cap_review: decision, cap_reviewed_at: new Date().toISOString() }),
    });
    logger.info(`🧾 [HYBRID] Capped memory ${memoryId} ${decision}d by ${userId}`);
    if (decision === 'approve') return `Approved #${memoryId}: importance ${row.importance} → ${importance}.`;
    return `Declined #${memoryId}: it stays at importance ${row.importance}.`;
  }

  async getRecentMemories(userId: string, limit: number = 10, guildId?: string): Promise<MemoryEntry[]> {
    if (this.useHybridLayer) {
      // FAST PATH: Use hybrid layer. guildId (when given) keeps other servers' memories out.
      try {
        const memories = await hybridDataLayer.getRecentMemories(userId, limit, guildId);

        return memories.map((memory) => ({
          id: memory.id,
          userId: memory.user_id,
          content: memory.content,
          tags: parseJsonTags(memory.tags),
          context: memory.context || '',
          timestamp: memory.timestamp,
          importance: memory.importance || 5,
          guildId: memory.guild_id ?? null,
        }));
      } catch (error) {
        logger.error('❌ [HYBRID] Failed to get recent memories:', error);
        throw error;
      }
    }

    // Legacy fallback removed
    return [];
  }

  async getMemoryStats(userId: string): Promise<string> {
    // Use hybrid layer for stats
    try {
      const recentMemories = await hybridDataLayer.getRecentMemories(userId, 1000);
      const totalCount = recentMemories.length;
      const recentCount = recentMemories.filter((m) => {
        const daysDiff = (Date.now() - new Date(m.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 7;
      }).length;

      return `📊 Memory Stats for ${userId}:
• Total memories: ${totalCount}
• Recent (7 days): ${recentCount}
• Storage: Hybrid layer (in-memory + SQLite)`;
    } catch (error) {
      throw new Error(`Could not retrieve memory statistics: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Extract keyword tags for immediate storage (before async semantic tagging).
   *
   * These tags are FTS index keys, and the previous version made them useless: it split the
   * text, dropped a short stopword list, and took the FIRST FIVE survivors. Because memories
   * are written as third-person narration ("Subway Builder — the main topic discussed is…"),
   * the keys it produced were narration vocabulary. Measured across 20,157 live memories:
   *   ["subway","builder","main","topic","discussed"]        x1031
   *   ["subway","builder","conversation","primarily","revolves"] x397
   *   ["subway","builder","main","topics","discussed"]        x207
   * Thousands of memories were therefore indistinguishable to search, which is a large part
   * of why 98% of them have never been recalled.
   *
   * Two changes: narration words are stopped, and selection is by DISTINCTIVENESS (longest,
   * deduped, position-independent) rather than by position. Returning fewer — or zero — tags
   * is better than returning noise, because noise actively poisons the index.
   */
  private extractBasicTags(content: string, _context: string): string[] {
    // Stopwords that matter here are not the usual English ones — they are the vocabulary of
    // LLM-written summaries, which is what memory content actually is.
    const NARRATION_WORDS = new Set([
      'main', 'topic', 'topics', 'discussed', 'discussion', 'discusses', 'discussing',
      'conversation', 'conversations', 'revolves', 'revolved', 'around', 'primarily',
      'centers', 'centered', 'centres', 'regarding', 'concerning', 'context', 'suggests',
      'suggested', 'indicates', 'indicated', 'appears', 'appeared', 'mentioned', 'mentions',
      'expressed', 'expresses', 'stated', 'states', 'noted', 'notes', 'observation',
      'observations', 'summary', 'summarized', 'message', 'messages', 'user', 'users',
      'previous', 'recent', 'dialogue', 'exchange', 'interaction', 'response', 'responded',
      'request', 'requested', 'asked', 'asks', 'theme', 'themes', 'key', 'features',
      'involves', 'involved', 'related', 'relates', 'highlighting', 'highlights',
      'information', 'details', 'specific', 'general', 'various', 'several', 'overall',
      'following', 'includes', 'including', 'provided', 'provides', 'seems', 'likely',
      'artie', 'coach', 'assistant', 'system', 'channel',
      // ordinary high-frequency English
      'that', 'this', 'with', 'from', 'have', 'they', 'their', 'there', 'these', 'those',
      'them', 'then', 'than', 'been', 'being', 'were', 'what', 'when', 'which', 'while',
      'would', 'could', 'should', 'about', 'into', 'over', 'also', 'just', 'like', 'some',
      'more', 'most', 'other', 'such', 'very', 'will', 'your', 'ours', 'because', 'after',
      'before', 'between', 'during', 'where', 'here', 'both', 'each', 'only', 'same',
      'said', 'says', 'make', 'made', 'take', 'takes', 'come', 'comes', 'time', 'times',
      'work', 'working', 'thing', 'things', 'want', 'wants', 'need', 'needs', 'know',
      'think', 'well', 'good', 'back', 'still', 'even', 'much', 'many', 'lot',
    ]);

    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const raw of content.toLowerCase().split(/[^a-z0-9_-]+/)) {
      const word = raw.replace(/^[-_]+|[-_]+$/g, '');
      // 4+ chars: 3-letter words are almost never distinctive in this corpus.
      if (word.length < 4 || word.length > 30) continue;
      if (NARRATION_WORDS.has(word)) continue;
      if (!/[a-z]/.test(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      candidates.push(word);
    }

    // Longest-first is a cheap, corpus-free proxy for specificity: "electrification" is a
    // better index key than "trains", and both beat "topic".
    return candidates.sort((a, b) => b.length - a.length).slice(0, 5);
  }

  private formatHybridRecallResults(memories: MemoryRecord[], query: string): string {
    const formatted = memories
      .map((memory, index) => {
        const tags = parseJsonTags(memory.tags);
        const context = memory.context || '';
        const importance = memory.importance || 5;

        const date = new Date(memory.timestamp).toLocaleDateString();
        const stars = '⭐'.repeat(Math.min(importance, 5));

        return `${index + 1}. #${memory.id} **${memory.content}** ${stars}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${contextSuffix(context)}`;
      })
      .join('\n\n');

    return `🧠 Recalled ${memories.length} memories for "${query}" (hybrid search):

${formatted}

💡 Use these memories to provide context for your response!`;
  }

  private async generateSemanticTagsHybrid(
    memoryId: number,
    content: string,
    context: string
  ): Promise<void> {
    try {
      logger.info(
        `🏷️ [HYBRID] Generating semantic tags for memory ${memoryId}: "${content.substring(0, 50)}..."`
      );

      const prompt = `Analyze this user memory and generate 3-8 semantic tags that would help find this memory later.

Memory: "${content}"
Context: "${context}"

Generate tags that capture:
- DOMAIN (food, music, work, travel, etc.)
- EMOTION (like, love, hate, prefer, etc.)
- CATEGORY (specific type, genre, style, etc.)
- RELATIONS (family, friend, colleague, etc.)

Return ONLY JSON with a list of lowercase tag strings, no other text.
Example: {"tags": ["food", "pizza", "italian", "preference", "like"]}`;

      const { openRouterService } = await import('../../4-generate/openrouter.js');

      // Use BACKGROUND_MODEL for cost efficiency — tagging is a background task
      const response = await openRouterService.generateFromMessageChain(
        taggingMessages(prompt),
        'memory-tagging-system',
        undefined,
        process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001',
        { jsonOutput: TAGS_OUTPUT }
      );
      const tags = this.parseTagsFromResponse(response);

      if (tags.length > 0) {
        // Update memory in hybrid layer
        const memory = await hybridDataLayer.getMemory(memoryId);
        if (memory) {
          const existingTags = parseJsonTags(memory.tags);
          const allTags = [...new Set([...existingTags, ...tags])];

          const updatedMemory = {
            ...memory,
            tags: JSON.stringify(allTags),
          };

          await hybridDataLayer.updateMemory(updatedMemory); // Update with new tags
          logger.info(
            `🏷️ [HYBRID] Added ${tags.length} semantic tags to memory ${memoryId}: ${tags.join(', ')}`
          );
        }
      }
    } catch (error) {
      logger.error(`❌ [HYBRID] Failed to generate semantic tags for memory ${memoryId}:`, error);
    }
  }

  private async generateSemanticTags(
    memoryId: number,
    content: string,
    context: string
  ): Promise<void> {
    try {
      logger.info(
        `🏷️ Generating semantic tags for memory ${memoryId}: "${content.substring(0, 50)}..."`
      );

      const prompt = `Analyze this user memory and generate 3-8 semantic tags that would help find this memory later.

Memory: "${content}"
Context: "${context}"

Generate tags that capture:
- DOMAIN (food, music, work, travel, etc.)
- EMOTION (like, love, hate, prefer, etc.) 
- CATEGORY (specific type, genre, style, etc.)
- RELATIONS (family, friend, colleague, etc.)

Return ONLY JSON with a list of lowercase tag strings, no other text.
Example: {"tags": ["food", "pizza", "italian", "preference", "like"]}`;

      const { openRouterService } = await import('../../4-generate/openrouter.js');

      const response = await openRouterService.generateFromMessageChain(
        taggingMessages(prompt),
        'memory-tagging-system',
        undefined,
        process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001',
        { jsonOutput: TAGS_OUTPUT }
      );

      // Parse the tags from LLM response
      const tags = this.parseTagsFromResponse(response);

      if (tags.length > 0) {
        // Update the memory with semantic tags
        await this.updateMemoryTags(memoryId, tags);
        logger.info(
          `🏷️ Added ${tags.length} semantic tags to memory ${memoryId}: ${tags.join(', ')}`
        );
      } else {
        logger.warn(`🏷️ No semantic tags generated for memory ${memoryId}`);
      }
    } catch (error) {
      logger.error(`❌ Failed to generate semantic tags for memory ${memoryId}:`, error);
    }
  }

  private parseTagsFromResponse(response: string): string[] {
    try {
      // {"tags": [...]}; a bare array (a model that ignored the wrapper) is read too.
      const wrapped = parseModelJson<{ tags?: unknown }>(response, 'object')?.tags;
      let tags: unknown[] | null;
      if (Array.isArray(wrapped)) {
        tags = wrapped;
      } else {
        tags = parseModelJson<unknown[]>(response, 'array');
      }
      if (tags) {
        return tags
          .filter((tag): tag is string => typeof tag === 'string' && tag.length > 1)
          .slice(0, 8);
      }
    } catch (parseError) {
      // Don't crash the entire response for memory parsing failures
      logger.warn(`Memory tag parsing failed, continuing without tags: ${parseError}`);
      return [];
    }

    return [];
  }

  private async updateMemoryTags(memoryId: number, semanticTags: string[]): Promise<void> {
    try {
      const db = getSyncDb();

      // Get current tags
      const result = db.get<{ tags: string }>(`SELECT tags FROM memories WHERE id = ?`, [memoryId]);
      if (!result) {
        return;
      }

      const currentTags = JSON.parse(result.tags || '[]');
      const allTags = [...new Set([...currentTags, ...semanticTags])]; // Merge and dedupe

      // Update memory with combined tags
      db.run(`UPDATE memories SET tags = ? WHERE id = ?`, [JSON.stringify(allTags), memoryId]);
    } catch (error) {
      logger.error(`❌ Failed to update tags for memory ${memoryId}:`, error);
    }
  }

  private formatRecallResults(results: MemoryRow[], query: string, searchType: string): string {
    logger.info(
      `🎨 Formatting ${results.length} recall results for query "${query}" using ${searchType}`
    );

    const formatted = results
      .map((memory, index) => {
        const tags = JSON.parse(memory.tags || '[]');
        const date = new Date(memory.created_at || memory.timestamp || '').toLocaleDateString();
        const importance = '⭐'.repeat(Math.min(memory.importance || 0, 5));

        const formattedEntry = `${index + 1}. **${memory.content}** ${importance}
   📅 ${date} | 🏷️ ${tags.join(', ') || 'no tags'}${contextSuffix(memory.context)}`;

        logger.info(`🎨 Formatted entry ${index + 1}: ${formattedEntry.substring(0, 100)}...`);

        return formattedEntry;
      })
      .join('\n\n');

    const finalOutput = `🧠 Recalled ${results.length} memories for "${query}" (${searchType}):

${formatted}

💡 Use these memories to provide context for your response!`;

    logger.info(`🎨 Final formatted output:
${finalOutput}`);

    return finalOutput;
  }
}

/**
 * Memory capability handler
 */
async function handleMemoryAction(
  params: MemoryParams,
  content?: string,
  context?: CapabilityContext
): Promise<string> {
  const { action } = params;
  // The real caller's context wins over any model-supplied userId (security audit 2026-10-26).
  const userId = context?.userId || params.userId || 'unknown-user';
  // The conversation's guild (undefined in DMs). Read here: `remember` shadows `context` below.
  const callerGuildId = context?.guildId;
  const fromConversation = context !== undefined;
  // Conversations use their own guild; only context-less internal callers may name one.
  const tagGuild = (): string | undefined => {
    if (fromConversation) {
      return callerGuildId;
    }
    return optionalString(params.guildId);
  };
  const memoryService = MemoryService.getInstance();

  logger.info(`🎯 Memory handler called - Action: ${action}, UserId: ${userId}, Params:`, params);
  if (content) {
    logger.info(`🎯 Memory handler content: ${content.substring(0, 100)}...`);
  }

  try {
    switch (action) {
      // store/save/add (and search below) are old synonyms — ACTION_ALIASES.memory in
      // registry.ts normalizes them to remember/recall before the handler ever sees them,
      // so only the canonical action names need a case here. Kept out of supportedActions
      // too, so the prompt roster shows remember/recall/forget/pin/recent/stats, not nine
      // names for six actions.
      case 'remember': {
        const contentToRemember = params.content || content;
        if (!contentToRemember || String(contentToRemember).trim() === 'undefined') {
          throw new Error('No content provided to remember');
        }

        const context = String(params.context || '');
        let importanceCeiling = 10;
        if (!isOwner(String(userId))) {
          importanceCeiling = NON_OWNER_MAX_IMPORTANCE;
        }
        const importance = Math.max(
          1,
          Math.min(importanceCeiling, parseInt(String(params.importance)) || 5)
        );

        // Get messageId from params (set by capability orchestrator)
        const relatedMessageId = optionalInt(params.messageId);

        // Get explicit tags if provided, plus `kind` (person | guild | pinned | scratch |
        // goal | ...) folded in as just another tag — the memory-zoo collapse (2026-10-26)
        // gives every kind of fact one home with one classification axis instead of a
        // separate tool per kind.
        // 'scope:*' is reserved for the scope marker below; a model can't forge it.
        const explicitTags = ensureStringArray(params.tags).filter(
          (t) => !t.startsWith(RESERVED_TAG_PREFIX)
        );
        if (
          params.kind &&
          typeof params.kind === 'string' &&
          !params.kind.startsWith(RESERVED_TAG_PREFIX)
        ) {
          explicitTags.push(params.kind);
        }
        // Scope (EJ 2026-11-17: "personal facts follow you"). Artie must choose every time:
        //  me   = a fact about the person asking: stored guild-free, recalled in any server/DM
        //  here = about this server, its projects or other people: stays in this guild
        // Before this, guildId was never passed in, so EVERY remembered fact was guild-free
        // and crossed between Room 302 and Subway Builder.
        let guildId: string | undefined;
        // self = a fact about Artie himself (EJ 2026-11-18: "allow him to form memories about
        // himself"). One owner for all of them, guild-free, and his top few ride in every
        // conversation (selfNotesLine), so: about him only, never someone else's details.
        let ownerId = String(userId);
        let selfMeta: Record<string, unknown> | undefined;
        if (params.scope === 'self') {
          ownerId = ARTIE_SELF_USER_ID;
          guildId = undefined;
          explicitTags.push(SELF_TAG);
          // Anyone talking to him can prompt a self-note, so keep the trail visible.
          selfMeta = { written_with: String(userId), written_in_guild: callerGuildId ?? null };
        } else if (params.scope === 'me') {
          guildId = undefined;
          // Marks it as a personal fact for recall's "about you" slot. Untagged guild-free rows
          // (everything written before 2026-11-17) are not treated as personal.
          explicitTags.push(PERSONAL_TAG);
        } else if (params.scope === 'here') {
          // A conversation's own guild; only internal callers with no context (observation,
          // reaction feedback) may name one, so a DM can't plant a memory in a server.
          if (fromConversation) {
            // In a DM there is no "here": guild-free would mean "follows them everywhere" and
            // a private fact about someone else would surface in every server (Codex).
            if (!callerGuildId) {
              throw new CallerError(
                'scope "here" needs a server, and this is a DM. Use scope "me" for something about this person or this conversation, or scope "self" for something about you, Artie.'
              );
            }
            guildId = callerGuildId;
          } else {
            guildId = optionalString(params.guildId);
          }
          // Every "here" write needs a real guild, internal callers included (Codex).
          if (!guildId) {
            throw new CallerError('scope "here" needs a guildId');
          }
        } else {
          throw new CallerError(
            'remember needs scope: "me" (about the asker, follows them), "here" (this server) or "self" (about you, Artie)'
          );
        }
        let tags: string[] | undefined;
        if (explicitTags.length > 0) {
          tags = explicitTags;
        } else {
          tags = undefined;
        }
        const channelId = optionalString(params.channelId);
        // Capped below what was asked: keep the ask so EJ can review it (memory capped / review).
        const askedImportance = parseInt(String(params.importance));
        if (Number.isFinite(askedImportance) && askedImportance > importance && importanceCeiling < 10) {
          selfMeta = { ...selfMeta, asked_importance: Math.min(10, askedImportance) };
        }

        const result = await memoryService.remember(
          ownerId,
          String(contentToRemember),
          context,
          importance,
          relatedMessageId,
          tags,
          guildId,
          channelId,
          selfMeta
        );
        logger.info(`🎯 Memory remember result: ${result}`);
        // A receipt, not a guess (Artie 2026-11-18: "I asked for 7 and it saved as 6, no warning").
        if (!result.startsWith('✅')) return result;
        const notes = [`scope: ${String(params.scope)}`];
        const asked = parseInt(String(params.importance));
        if (Number.isFinite(asked) && asked !== importance) {
          let why = 'importance runs 1-10';
          if (asked > importanceCeiling && importanceCeiling < 10) {
            why = `above ${importanceCeiling} needs EJ in the conversation; queued for his review, see memory capped`;
          }
          notes.push(`importance ${asked} asked, ${importance} stored (${why})`);
        }
        return `${result} [${notes.join('; ')}]`;
      }

      case 'recall': {
        const query = params.query || content;
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 5));
        // His notes about himself, only those visible in this conversation (same rule as the 🪞 line).
        if (params.scope === 'self') {
          return searchSelfNotes(String(query || ''), String(userId), callerGuildId ?? null, limit);
        }
        if (!query && ensureStringArray(params.tags).length === 0) {
          throw new CallerError('No query or tags provided for search');
        }

        // Only EJ may search someone else's memories; everyone else searches their own, whatever
        // `user` the model passes (security audit 2026-10-26: this used to let anyone read EJ's).
        const targetUserId = recallTargetUser(params.user, String(userId));

        // Tag lookup (Artie's ask, 2026-10-28: "let me find my own notes later").
        const wantedTags = ensureStringArray(params.tags);
        if (wantedTags.length > 0) {
          const tagged = await memoryService.recallByTags(
            targetUserId,
            wantedTags,
            limit,
            tagGuild()
          );
          if (tagged.length === 0) {
            return `🏷️ No memories tagged ${wantedTags.join(', ')}.`;
          }
          return tagged
            .map((m, i) => {
              const date = new Date(m.timestamp).toLocaleDateString();
              return `${i + 1}. [#${m.id}, ${date}, importance ${m.importance}] ${m.content}\n   tags: ${m.tags.join(', ')}`;
            })
            .join('\n');
        }

        logger.info(`🎯 Memory search starting - Query: "${query}"`);
        const result = await memoryService.recall(targetUserId, String(query), limit, context?.guildId);
        logger.info(`🎯 Memory search completed - Result length: ${result.length} characters`);
        return result;
      }

      case 'stats': {
        return await memoryService.getMemoryStats(String(userId));
      }

      case 'recent': {
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 10));
        // This server's only (Codex crew: recent used to show other servers' "here" notes).
        const memories = await memoryService.getRecentMemories(String(userId), limit, callerGuildId);

        if (memories.length === 0) {
          return '📭 No recent memories found. Start remembering things to build your memory!';
        }

        const formatted = memories
          .map((memory, index) => {
            const date = new Date(memory.timestamp).toLocaleDateString();
            const importance = '⭐'.repeat(Math.min(memory.importance, 5));
            const pinnedMark = pinnedMarker(memory.importance);
            return `${index + 1}. #${memory.id} **${memory.content}** ${importance}${pinnedMark} (${date})`;
          })
          .join('\n');

        return `📚 Your ${memories.length} most recent memories:\n\n${formatted}`;
      }

      case 'pin': {
        const memoryId = params.memoryId || params.id || content;
        if (!memoryId) {
          throw new Error('No memory ID provided to pin. Use the memory ID from recall results.');
        }

        logger.info(`📌 Pinning memory ${memoryId} for user ${userId}`);
        const result = await memoryService.pinMemory(
          String(userId),
          parseInt(String(memoryId).trim().replace(/^#/, '')),
          callerGuildId
        );
        logger.info(`📌 Pin result: ${result}`);
        return result;
      }

      case 'forget': {
        const memoryId = params.memoryId || params.id || content;
        if (!memoryId) {
          throw new Error('No memory ID provided to forget. Use the memory ID from recall results.');
        }

        logger.info(`🗑️ Forgetting memory ${memoryId} for user ${userId}`);
        const result = await memoryService.forgetMemory(
          String(userId),
          parseInt(String(memoryId).trim().replace(/^#/, '')),
          callerGuildId
        );
        logger.info(`🗑️ Forget result: ${result}`);
        return result;
      }

      case 'restore': {
        const memoryId = params.memoryId || params.id || content;
        if (!memoryId) {
          throw new Error('No memory ID provided to restore. Use the #id from the dream journal.');
        }
        // The journal writes ids as "#123"; accept that form too.
        const parsedId = Number(String(memoryId).trim().replace(/^#/, ''));
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          throw new Error(`"${String(memoryId).slice(0, 20)}" isn't a memory id. Use the number from the dream journal, like 123.`);
        }
        return memoryService.restoreMemory(String(userId), parsedId, callerGuildId);
      }

      case 'dropped': {
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 10));
        return memoryService.listDropped(String(userId), callerGuildId ?? null, String(params.query || content || ''), limit);
      }

      case 'capped': {
        const limit = Math.max(1, Math.min(20, parseInt(String(params.limit)) || 10));
        return memoryService.listCapped(String(userId), callerGuildId ?? null, limit);
      }

      case 'review': {
        const parsedId = Number(String(params.memoryId || params.id || '').trim().replace(/^#/, ''));
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          throw new CallerError('review needs the id of a capped note (memory capped lists them)');
        }
        return memoryService.reviewCapped(String(userId), parsedId, String(params.decision || ''), callerGuildId);
      }

      default:
        throw new Error(
          `Unknown memory action: ${action}. Supported actions: remember, recall, forget, pin, restore, dropped, capped, review, recent, stats`
        );
    }
  } catch (error) {
    logger.error(`Memory capability error for action '${action}':`, error);
    throw error;
  }
}

/**
 * Memory capability definition with real persistence
 */
export const memoryCapability: RegisteredCapability = {
  name: 'memory',
  emoji: '🧠',
  supportedActions: ['remember', 'recall', 'forget', 'pin', 'restore', 'dropped', 'capped', 'review', 'recent', 'stats'],
  // Params as handleMemoryAction reads them. Writes are Artie's own state (`own`).
  actions: {
    remember: {
      effect: 'own',
      // The fact itself: handleMemoryAction reads params.content || content.
      content: 'The fact to remember, one self-contained sentence',
      params: {
        scope: {
          type: 'string',
          enum: ['me', 'here', 'self'],
          description:
            'Where the fact may travel. In a DM, me (this person or this conversation) or self. ' +
            'self = about you, Artie: how you work, what you learned, what you want. Shows where it was written (everywhere if written with EJ); never another person\'s details. ' +
            'me = true anywhere (pronouns, timezone, "hates long replies"); it follows the person to every server. ' +
            'here = server-specific, even about a person ("Jan builds Tokyo maps in Subway Builder"); it stays in this server. ' +
            'Unsure: here (a wrong here stays put, a wrong me leaks across servers).',
          required: true,
        },
        kind: {
          type: 'string',
          description:
            'What the fact is about (a label, not where it travels; scope does that): person|preference|project|event|lore|rule|tool|goal|pinned. kind=person works with either scope.',
        },
        tags: { type: 'string', description: 'Comma-separated tags to find it again' },
        importance: { type: 'integer', description: '1-10 (default 5)' },
        context: { type: 'string', description: 'Where or why this came up' },
      },
    },
    recall: {
      effect: 'read',
      params: {
        query: { type: 'string', description: 'What to look for' },
        tags: { type: 'string', description: 'Comma-separated tags to find it again' },
        limit: { type: 'integer', description: 'Max results (default 5, max 20)' },
        user: { type: 'string', description: "Someone else's memories (EJ only)" },
        scope: { type: 'string', enum: ['self'], description: 'self = search your notes about yourself (empty query lists them)' },      },
    },
    forget: {
      effect: 'own',
      params: { memoryId: { type: 'integer', description: 'Memory id', required: true, aliases: ['id'] } },
    },
    pin: {
      effect: 'own',
      params: { memoryId: { type: 'integer', description: 'Memory id', aliases: ['id'] } },
    },
    restore: {
      effect: 'own',
      params: {
        memoryId: { type: 'integer', description: 'Id of a memory the nightly dream let go (#id in the dream journal)', required: true, aliases: ['id'] },
      },
    },
    dropped: {
      effect: 'read',
      params: {
        query: { type: 'string', description: 'Words to look for among what the dream let go (empty = newest)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)' },
      },
    },
    capped: {
      effect: 'read',
      params: { limit: { type: 'integer', description: 'Max results (default 10, max 20)' } },
    },
    review: {
      effect: 'own',
      params: {
        memoryId: { type: 'integer', description: 'Id of a capped note (from memory capped)', required: true, aliases: ['id'] },
        decision: { type: 'string', enum: ['approve', 'decline'], description: 'approve raises it to the importance asked; decline keeps it', required: true },
      },
    },
    recent: { effect: 'read', params: { limit: { type: 'integer', description: 'How many' } } },
    stats: { effect: 'read' },
  },
  description:
    // Native tool schema shows only the first line, clipped at 200 chars (tool-schema.ts), so the
    // use-when sentence comes first; the scope guidance lives in the scope param description.
    'Save or find ONE fact (tagged, searchable) about a person, this server, or yourself; the default place to remember things. Set scope: me, here or self. Running server notebook: scratchpad.\n' +
    'scope=me facts follow a person to every server and DMs are me-only; scope=here stays in this server (when unsure, here). ' +
    'kind=person|preference|project|event|lore|rule|tool|goal|pinned says what the fact is about; scope says where it may travel. ' +
    'tags="a,b" files a memory, recall tags="a" finds it again. A nightly dream pass re-tags memories and prunes junk. ' +
    'NOT for structured profile fields like email/timezone (use user-profile) or agent handoffs (system_memory, EJ only). ' +
    '"pin" marks something important (importance 10); "forget" deletes it; "restore" undoes a dream prune you disagree with. ' +
    '"dropped" searches what the dream let go (when someone says "you used to know this", look there before asking them again). ' +
    '"capped" lists notes stored below the importance asked (only EJ writes above 6); EJ approves or declines each with "review".',
  handler: handleMemoryAction,
  examples: [
    '<capability name="memory" action="remember" scope="here" kind="project" tags="monetization,stripe">Tier-list commissions idea, risk: becomes a chore</capability>',
    '<capability name="memory" action="recall" tags="monetization" limit="5" />',
    '<capability name="memory" action="remember" scope="me" kind="preference" importance="8">Prefers short answers</capability>',
    '<capability name="memory" action="recall" query="chocolate preferences" />',
    '<capability name="memory" action="recall" query="food" user="john" limit="3" />',
    '<capability name="memory" action="stats" />',
    '<capability name="memory" action="recent" limit="5" />',
    '<capability name="memory" action="pin" memoryId="123">Pin an important tool learning from recent memories</capability>',
    '<capability name="memory" action="forget" memoryId="123" />',
  ],
};

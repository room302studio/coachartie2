/**
 * Dream: the nightly LLM pass over Artie's memories (EJ, 2026-10-28: "a nightly
 * pruning-and-tagging dream cron"). Runs as the first step of the gardener, so the
 * gardener's tag-based linking works off tags this pass just cleaned up.
 *
 * Each night a background model reads up to DREAM_BATCH memories it hasn't seen, and per memory:
 *   - picks one `kind` (KINDS) and 2-5 topic tags, reusing the seed vocabulary: EJ's own site
 *     tags (ejfox.com/tags.json) plus the tags Artie already uses most, so tags converge
 *     instead of every memory inventing its own words;
 *   - says keep or junk. Junk (test runs, empty stubs, tool trivia) is soft-pruned the same way
 *     the gardener prunes: importance 1, which every recall path hides, with the previous
 *     importance kept in metadata so it can be undone. Nothing is deleted. Importance >= 9 and
 *     pinned memories are never pruned.
 */

import { logger } from '../../shared/logger.js';
import { getSyncDb } from '../../shared/db/client.js';
import { isGenerationMuted } from '../../shared/kill-switch.js';
import { parseModelJson } from '../../shared/model-json.js';
import type { JsonOutputSpec } from '../../shared/structured-output.js';
import type { ChatMessage } from '../3-context/prompt-cache.js';

export const KINDS = [
  'person',
  'preference',
  'project',
  'event',
  'lore',
  'rule',
  'tool',
  'goal',
] as const;

const DREAM_BATCH = Number(process.env.DREAM_BATCH) || 60;
const CHUNK = 15; // memories per model call
// ~70 output tokens per verdict. Without an explicit budget the call gets LLM_MAX_TOKENS (400)
// and the verdict array is cut off mid-JSON.
const CHUNK_MAX_TOKENS = 1600;
const CONTENT_CLIP = 400;
const SEED_URL = process.env.DREAM_TAGS_URL || 'https://ejfox.com/tags.json';
const PROTECTED_IMPORTANCE = 9;
/** Tags that record how a memory was made, not what it's about: never offered as vocabulary. */
const BOOKKEEPING_TAGS = new Set([
  'reflection',
  'reflection_v2',
  'reflection_v3',
  'capability-reflection',
  'observation',
  'daily-summary',
  'conversation',
  'pruned',
]);
/** Tags other code reads by name: never dropped by the re-tag. */
const STRUCTURAL_TAGS = new Set([
  'pinned',
  'quest', // tasks tool queries tags LIKE '%"quest"%'
  'user-profile',
  'passive-learning', // recall filters on it (store.ts)
  'channel-fact',
]);

interface Candidate {
  id: number;
  content: string;
  tags: string;
  importance: number;
  metadata: string | null;
}

export interface DreamVerdict {
  id: number;
  kind: string;
  tags: string[];
  verdict: 'keep' | 'junk';
  reason?: string;
}

export interface DreamResult {
  reviewed: number;
  tagged: number;
  pruned: number;
}

const DREAM_OUTPUT: JsonOutputSpec = {
  name: 'memory_dream',
  schema: {
    type: 'object',
    properties: {
      memories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            kind: { type: 'string', enum: [...KINDS] },
            tags: { type: 'array', items: { type: 'string' } },
            verdict: { type: 'string', enum: ['keep', 'junk'] },
            reason: { type: 'string' },
          },
          required: ['id', 'kind', 'tags', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['memories'],
    additionalProperties: false,
  },
};

/** lowercase, spaces -> hyphens, no leading "!" (EJ's action tags like !tobuy aren't topics). */
export function normalizeTag(tag: unknown): string {
  return String(tag)
    .trim()
    .toLowerCase()
    .replace(/^!+/, '')
    .replace(/\s+/g, '-');
}

function parseTags(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json || '[]');
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // malformed tags column: treat as untagged
  }
  return [];
}

/** EJ's site tags. Empty on any failure: the dream then leans on Artie's own vocabulary. */
async function fetchSeedTags(): Promise<string[]> {
  try {
    const res = await fetch(SEED_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((t) => typeof t === 'string' && !t.startsWith('!')).map(normalizeTag);
  } catch (error) {
    logger.warn('[dream] Seed tags unavailable, using Artie vocabulary only:', error);
    return [];
  }
}

/** The tags Artie already uses most, minus bookkeeping tags that say nothing about topic. */
function topExistingTags(limit = 60): string[] {
  const db = getSyncDb();
  const rows = db.all<{ tag: string; n: number }>(
    `SELECT lower(j.value) AS tag, COUNT(*) AS n
       FROM memories, json_each(memories.tags) j
      WHERE json_valid(memories.tags) AND importance > 2
      GROUP BY tag ORDER BY n DESC LIMIT ?`,
    [limit * 2]
  );
  return rows
    .map((r) => normalizeTag(r.tag))
    .filter((t) => t && !BOOKKEEPING_TAGS.has(t) && !(KINDS as readonly string[]).includes(t))
    .slice(0, limit);
}

function candidates(limit: number): Candidate[] {
  const db = getSyncDb();
  return db.all<Candidate>(
    `SELECT id, content, tags, importance, metadata FROM memories
      WHERE importance > 1
        AND (metadata IS NULL OR NOT json_valid(metadata) OR json_extract(metadata, '$.dreamt_at') IS NULL)
      ORDER BY id DESC LIMIT ?`,
    [limit]
  );
}

function dreamMessages(vocab: string[], batch: Candidate[]): ChatMessage[] {
  const system = `You curate a Discord bot's long-term memory. For each memory decide:
- kind: exactly one of ${KINDS.join(', ')}
- tags: 2-5 lowercase topic tags. Reuse tags from VOCABULARY whenever one fits; invent at most ONE new tag per memory, only if nothing fits. No names of the kind itself, no "memory"/"reflection".
- verdict: "junk" only if it holds nothing worth recalling later: test runs or smoke tests, tool-success trivia (e.g. "the calculator computed 123*456"), empty stubs ("N messages exchanged"), or pure filler. Opinions, jokes with context, facts about people, plans and lore are "keep". When unsure, keep.
- reason: a few words.
Reply with JSON only.

VOCABULARY: ${vocab.join(', ')}`;
  const user = batch
    .map(
      (m) =>
        `#${m.id} (importance ${m.importance}, current tags: ${parseTags(m.tags).join(', ') || 'none'})\n${m.content.slice(0, CONTENT_CLIP)}`
    )
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * The reply as a verdict list. Auto-routed models don't all honor response_format: some send
 * {"memories":[...]}, some a bare [...] in a ```json fence. parseModelJson alone grabs the
 * first {...} or [...] it meets, which here is one verdict or one tags array, so parse the
 * whole (unfenced) reply first. Exported for tests.
 */
export function parseVerdicts(raw: string): DreamVerdict[] | null {
  const text = String(raw ?? '').trim();
  const unfenced = text.startsWith('```')
    ? text.slice(text.indexOf('\n') + 1, text.lastIndexOf('```')).trim()
    : text;
  let whole: unknown = null;
  try {
    whole = JSON.parse(unfenced);
  } catch {
    whole = parseModelJson(unfenced, 'object');
  }
  let list: unknown = whole;
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    // {"memories": [...]}, or whatever key the model chose ({"m": [...]} seen 2026-10-28)
    list = Object.values(whole).find(Array.isArray);
  }
  if (!Array.isArray(list)) return null;
  return list.filter((v): v is DreamVerdict => !!v && typeof v === 'object' && 'id' in v);
}

/**
 * Apply one verdict. Exported for tests. Returns what happened so the caller can count it.
 */
export function applyVerdict(
  memory: Candidate,
  v: DreamVerdict,
  now: string,
  vocab: Set<string> = new Set()
): 'tagged' | 'pruned' | 'skipped' {
  const db = getSyncDb();
  const kind = (KINDS as readonly string[]).includes(v.kind) ? v.kind : null;
  const newTags = (Array.isArray(v.tags) ? v.tags : []).map(normalizeTag).filter(Boolean).slice(0, 5);
  const existing = parseTags(memory.tags);
  // Old write-time tags were often filler ("this", "main", "primarily"). Keep the ones that
  // carry meaning (vocabulary, kinds, structural markers); the model's tags replace the rest.
  const keptExisting = existing.filter((t) => {
    const n = normalizeTag(t);
    return vocab.has(n) || BOOKKEEPING_TAGS.has(n) || STRUCTURAL_TAGS.has(n) || (KINDS as readonly string[]).includes(n);
  });
  const merged = [...new Set([...keptExisting, ...(kind ? [kind] : []), ...newTags])];

  const protectedMemory =
    memory.importance >= PROTECTED_IMPORTANCE || existing.map((t) => t.toLowerCase()).includes('pinned');
  const prune = v.verdict === 'junk' && !protectedMemory;

  if (prune) {
    db.run(
      `UPDATE memories SET importance = 1, tags = ?,
         metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           '$.dreamt_at', ?, '$.pruned_by', 'dream', '$.pruned_reason', ?, '$.importance_before_dream', ?)
       WHERE id = ?`,
      [JSON.stringify([...new Set([...merged, 'pruned'])]), now, String(v.reason || ''), memory.importance, memory.id]
    );
    return 'pruned';
  }
  db.run(
    `UPDATE memories SET tags = ?,
       metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.dreamt_at', ?)
     WHERE id = ?`,
    [JSON.stringify(merged), now, memory.id]
  );
  return JSON.stringify(merged) === JSON.stringify(existing) ? 'skipped' : 'tagged';
}

export async function dream(limit = DREAM_BATCH): Promise<DreamResult> {
  const result: DreamResult = { reviewed: 0, tagged: 0, pruned: 0 };
  if (isGenerationMuted()) {
    logger.info('[dream] 💤 Skipped: generation muted');
    return result;
  }

  const pool = candidates(limit);
  if (pool.length === 0) return result;

  const vocab = [...new Set([...(await fetchSeedTags()), ...topExistingTags()])];
  const vocabSet = new Set(vocab);
  const { openRouterService } = await import('../4-generate/openrouter.js');
  const model = process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001';
  const now = new Date().toISOString();

  for (let i = 0; i < pool.length; i += CHUNK) {
    const batch = pool.slice(i, i + CHUNK);
    try {
      const raw = await openRouterService.generateFromMessageChain(
        dreamMessages(vocab, batch),
        'memory-dream',
        undefined,
        model,
        { jsonOutput: DREAM_OUTPUT, maxTokens: CHUNK_MAX_TOKENS }
      );
      // auto-routed models don't all honor response_format; some answer with a bare array.
      const verdicts = parseVerdicts(raw);
      if (!Array.isArray(verdicts)) {
        logger.warn(`[dream] Unparseable reply for chunk at #${batch[0]?.id}: ${String(raw).slice(0, 300)}`);
        continue;
      }
      const byId = new Map(batch.map((m) => [m.id, m]));
      for (const v of verdicts) {
        const memory = byId.get(Number(v.id));
        if (!memory) continue; // the model named an id it wasn't given
        const outcome = applyVerdict(memory, v, now, vocabSet);
        result.reviewed++;
        if (outcome === 'pruned') result.pruned++;
        if (outcome === 'tagged') result.tagged++;
      }
    } catch (error) {
      // One bad chunk shouldn't cost the rest of the night; its memories stay undreamt for tomorrow.
      logger.warn(`[dream] Chunk starting at #${batch[0]?.id} failed:`, error);
    }
  }

  logger.info(
    `[dream] 💭 Reviewed ${result.reviewed}, tagged ${result.tagged}, pruned ${result.pruned} (vocab ${vocab.length})`
  );
  return result;
}

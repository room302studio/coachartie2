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
import { isOwner } from '../../shared/config/owner.js';
import { parseModelJson } from '../../shared/model-json.js';
import type { JsonOutputSpec } from '../../shared/structured-output.js';
import type { ChatMessage } from '../3-context/prompt-cache.js';

const KINDS = [
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
const CHUNK = 10; // memories per model call
// ~70 output tokens per verdict compact, ~2x that when a model pretty-prints. 15 per call at 1600
// tokens got cut off mid-JSON on the first real night (91 of 256 unreviewed, 2026-10-29).
// 2026-11-20: auto:low models spent all 2500 on reasoning, every chunk, and only the ladder's
// retry (double room, reasoning off) answered: 12 wasted calls a night and a distress alert.
// Ask the way the retry does from the start.
const CHUNK_MAX_TOKENS = 5000;
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
  'scope:me', // memory.ts PERSONAL_TAG: recall's "about you" slot reads only rows carrying it
  'quest', // tasks tool queries tags LIKE '%"quest"%'
  'user-profile',
  'passive-learning', // recall filters on it (store.ts)
  'channel-fact',
  'dream-journal', // the dream's own nightly record (dreamRecallLine reads it)
]);

interface Candidate {
  id: number;
  user_id: string;
  content: string;
  tags: string;
  importance: number;
  metadata: string | null;
  guild_id?: string | null;
}

/** Who can see a memory: its owner plus its server (or none). Duplicates only count within one. */
function audienceKey(m: Candidate): string {
  return `${m.user_id}|${m.guild_id ?? ''}`;
}

/** Tags the caller chose at save time (memory.ts withExplicitTags); the dream never drops them. */
function explicitTagsOf(metadata: string | null): string[] {
  try {
    const parsed = JSON.parse(metadata || '{}');
    if (parsed && Array.isArray(parsed.explicit_tags)) return parsed.explicit_tags.map(String);
  } catch {
    // unreadable metadata: nothing explicit to keep
  }
  return [];
}

/**
 * Why something was junk. Counted per night so the junk Artie keeps *creating* is visible
 * (Artie, 2026-10-28: "helps me understand what patterns to stop creating in the first place").
 */
const JUNK_CATEGORIES = ['stub', 'duplicate', 'outdated', 'test', 'filler'] as const;

interface DreamVerdict {
  id: number;
  kind: string;
  tags: string[];
  verdict: 'keep' | 'junk';
  category?: string;
  reason?: string;
}

export interface DreamResult {
  reviewed: number;
  tagged: number;
  pruned: number;
  prunedBy?: Record<string, number>;
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
            category: { type: 'string', enum: [...JUNK_CATEGORIES, 'none'] },
            reason: { type: 'string' },
          },
          required: ['id', 'kind', 'tags', 'verdict', 'category', 'reason'],
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
    `SELECT id, user_id, content, tags, importance, metadata, guild_id FROM memories
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
- verdict: "junk" only if it holds nothing worth recalling later: test runs or smoke tests, tool-success trivia (e.g. "the calculator computed 123*456"), empty stubs ("N messages exchanged"), or pure filler. Opinions, jokes with context, facts about people, plans and lore are "keep". Small facts about a specific person are always "keep", however minor they look: what they're building, a name, place or pet they mentioned once, a plan they have; those are what let Artie ask "how's the Tokyo map going?". When unsure, keep.
- category: for junk, exactly one of stub (auto-generated summary/digest with no content), duplicate (repeats another memory in this batch with the SAME audience letter; a repeat under a different audience is not a duplicate), outdated (superseded or no longer true), test (test runs, tool trivia), filler (vague or contentless). For keep: "none".
- reason: a few words.
Reply with compact JSON only (no indentation or line breaks): {"memories":[{"id":123,"kind":"...","tags":[...],"verdict":"...","category":"...","reason":"..."}, ...]}.

VOCABULARY: ${vocab.join(', ')}`;
  // Audience as a letter, not ids: enough for "same people can see it", nothing to leak.
  const letters = new Map<string, string>();
  const letterFor = (m: Candidate): string => {
    const key = audienceKey(m);
    if (!letters.has(key)) letters.set(key, audienceLetter(letters.size));
    return letters.get(key) as string;
  };
  const user = batch
    .map(
      (m) =>
        `#${m.id} (audience ${letterFor(m)}, importance ${m.importance}, current tags: ${parseTags(m.tags).join(', ') || 'none'})\n${m.content.slice(0, CONTENT_CLIP)}`
    )
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Who sees a let-go in the journal and may restore it. A self-note (artie-self) belongs to the
 * person it was written with, same as forget/restore (Codex crew 2026-11-18).
 */
function letGoOwner(memory: Candidate): string {
  if (memory.user_id !== 'artie-self') return memory.user_id;
  try {
    const parsed = JSON.parse(memory.metadata || '{}');
    if (parsed && typeof parsed.written_with === 'string') return parsed.written_with;
  } catch {
    // no trail: falls back to artie-self, which only EJ sees
  }
  return memory.user_id;
}

/** 0 → A, 25 → Z, 26 → AA. */
function audienceLetter(n: number): string {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/**
 * A "duplicate" prune only stands when another memory with the same audience in this batch was
 * kept; otherwise it becomes a keep (Codex crew 2026-11-18: the same note saved in two servers
 * could lose one server's only copy). Exported for tests.
 */
function guardDuplicates(batch: Candidate[], verdicts: DreamVerdict[]): DreamVerdict[] {
  const byId = new Map(batch.map((m) => [m.id, m]));
  const keptAudiences = new Set<string>();
  for (const v of verdicts) {
    const m = byId.get(Number(v.id));
    if (m && v.verdict !== 'junk') keptAudiences.add(audienceKey(m));
  }
  return verdicts.map((v) => {
    const m = byId.get(Number(v.id));
    if (!m || v.verdict !== 'junk' || junkCategory(v.category) !== 'duplicate') return v;
    if (keptAudiences.has(audienceKey(m))) return v;
    return { ...v, verdict: 'keep', category: 'none', reason: 'duplicate of a memory in another audience' };
  });
}

function junkCategory(category: unknown): string {
  const c = String(category ?? '').toLowerCase();
  if ((JUNK_CATEGORIES as readonly string[]).includes(c)) return c;
  return 'filler';
}

function isKind(kind: unknown): kind is string {
  return (KINDS as readonly string[]).includes(kind as string);
}

/** A verdict's tags, normalized; the model sometimes omits or mangles the list. */
function verdictTags(v: DreamVerdict): string[] {
  if (!Array.isArray(v.tags)) return [];
  return v.tags.map(normalizeTag).filter(Boolean);
}

/** A reply wrapped in a ``` fence, without the fence. */
function stripCodeFence(text: string): string {
  if (!text.startsWith('```')) return text;
  return text.slice(text.indexOf('\n') + 1, text.lastIndexOf('```')).trim();
}

/** Verdicts keyed by memory id ({"20508": {...}}) as a list, or undefined if not that shape. */
function verdictsKeyedById(whole: object): unknown[] | undefined {
  const entries = Object.entries(whole);
  const keyedById = entries.length > 0 && entries.every(([k, v]) => /^\d+$/.test(k) && v && typeof v === 'object');
  if (!keyedById) return undefined;
  return entries.map(([k, v]) => ({ id: Number(k), ...(v as object) }));
}

/**
 * The reply as a verdict list. Auto-routed models don't all honor response_format: some send
 * {"memories":[...]}, some a bare [...] in a ```json fence. parseModelJson alone grabs the
 * first {...} or [...] it meets, which here is one verdict or one tags array, so parse the
 * whole (unfenced) reply first. Exported for tests.
 */
export function parseVerdicts(raw: string): DreamVerdict[] | null {
  const text = String(raw ?? '').trim();
  const unfenced = stripCodeFence(text);
  let whole: unknown = null;
  try {
    whole = JSON.parse(unfenced);
  } catch {
    whole = parseModelJson(unfenced, 'object');
  }
  let list: unknown = whole;
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    // {"memories": [...]}, or whatever key the model chose ({"m": [...]} seen 2026-10-28),
    // or verdicts keyed by id: {"20508": {...}, ...} (also seen 2026-10-28).
    list = Object.values(whole).find(Array.isArray) ?? verdictsKeyedById(whole);
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
  const kindTags = [v.kind].filter(isKind);
  const newTags = verdictTags(v).slice(0, 5);
  const existing = parseTags(memory.tags);
  // Old write-time tags were often filler ("this", "main", "primarily"). Keep the ones that
  // carry meaning (vocabulary, kinds, structural markers); the model's tags replace the rest.
  // Also kept: every scope marker (scope:me / scope:self / ...) and the caller's own tags.
  const explicit = new Set(explicitTagsOf(memory.metadata).map(normalizeTag));
  const keptExisting = existing.filter((t) => {
    const n = normalizeTag(t);
    return (
      vocab.has(n) ||
      BOOKKEEPING_TAGS.has(n) ||
      STRUCTURAL_TAGS.has(n) ||
      n.startsWith('scope:') ||
      explicit.has(n) ||
      isKind(n)
    );
  });
  const merged = [...new Set([...keptExisting, ...kindTags, ...newTags])];

  const protectedMemory =
    memory.importance >= PROTECTED_IMPORTANCE || existing.map((t) => t.toLowerCase()).includes('pinned');
  const prune = v.verdict === 'junk' && !protectedMemory;

  // Both writes only land if the row is still what the model saw (same importance and tags):
  // a memory pinned or raised while its verdict was pending must not be pruned or re-tagged
  // from the stale snapshot (Codex crew 2026-11-18).
  if (prune) {
    const pruned = db.run(
      `UPDATE memories SET importance = 1, tags = ?,
         metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
           '$.dreamt_at', ?, '$.pruned_by', 'dream', '$.pruned_category', ?, '$.pruned_reason', ?,
           '$.importance_before_dream', ?)
       WHERE id = ? AND importance = ? AND tags IS ?`,
      [
        JSON.stringify([...new Set([...merged, 'pruned'])]),
        now,
        junkCategory(v.category),
        String(v.reason || ''),
        memory.importance,
        memory.id,
        memory.importance,
        memory.tags,
      ]
    );
    if (pruned.changes > 0) return 'pruned';
    markDreamtOnly(memory.id, now);
    return 'skipped';
  }
  const retagged = db.run(
    `UPDATE memories SET tags = ?,
       metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.dreamt_at', ?)
     WHERE id = ? AND importance = ? AND tags IS ?`,
    [JSON.stringify(merged), now, memory.id, memory.importance, memory.tags]
  );
  if (retagged.changes === 0) {
    markDreamtOnly(memory.id, now);
    return 'skipped';
  }
  if (JSON.stringify(merged) === JSON.stringify(existing)) return 'skipped';
  return 'tagged';
}

/** The row changed under the dream: leave it as it is now, just don't review it again. */
function markDreamtOnly(id: number, now: string): void {
  getSyncDb().run(
    `UPDATE memories SET
       metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.dreamt_at', ?)
     WHERE id = ?`,
    [now, id]
  );
}

export async function dream(limit = DREAM_BATCH): Promise<DreamResult> {
  const result: DreamResult = { reviewed: 0, tagged: 0, pruned: 0 };
  if (isGenerationMuted()) {
    logger.info('[dream] 💤 Skipped: generation muted');
    return result;
  }

  const pool = candidates(limit);
  if (pool.length === 0) return result;

  // Don't start a night we can't pay for. Leave one plain journal line so Artie knows why there
  // was no dream, instead of a night of failed calls he'd read as a problem with his memories.
  const { creditMonitor } = await import('../budget/openrouter-balance.js');
  if (!(await creditMonitor.canAffordBackgroundWork())) {
    logger.warn('[dream] 💤 Skipped: out of model credits');
    writeDreamJournal(
      `Dream journal (${journalDay(new Date().toISOString())}): no dream; the model account was out of credits, so nothing was reviewed. Your memories are untouched and wait for the next dream.`,
      result
    );
    return result;
  }

  const vocab = [...new Set([...(await fetchSeedTags()), ...topExistingTags()])];
  const vocabSet = new Set(vocab);
  const { openRouterService } = await import('../4-generate/openrouter.js');
  const model = process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001';
  const now = new Date().toISOString();

  const examples: Record<string, string> = {};
  const newTagCounts = new Map<string, number>();
  let failedChunks = 0;
  const unreachedBy = new Map<string, number>();
  let unsavedChunks = 0;
  const letGo: LetGo[] = [];
  for (let i = 0; i < pool.length; i += CHUNK) {
    const batch = pool.slice(i, i + CHUNK);
    let raw: string;
    try {
      raw = await openRouterService.generateFromMessageChain(
        dreamMessages(vocab, batch),
        'memory-dream',
        undefined,
        model,
        { jsonOutput: DREAM_OUTPUT, maxTokens: CHUNK_MAX_TOKENS, reasoning: { enabled: false } }
      );
    } catch (error) {
      // One bad chunk shouldn't cost the rest of the night; its memories stay undreamt for tomorrow.
      // A call that never got an answer is not an unreadable answer: Nov 15-17 the account was out
      // of credits and the journal told Artie his batches "didn't come back readable".
      const reason = unreachedReasonFor(error);
      unreachedBy.set(reason, (unreachedBy.get(reason) ?? 0) + 1);
      logger.warn(`[dream] Chunk starting at #${batch[0]?.id} failed:`, error);
      continue;
    }
    try {
      // auto-routed models don't all honor response_format; some answer with a bare array.
      const verdicts = parseVerdicts(raw);
      if (!Array.isArray(verdicts)) {
        failedChunks++;
        logger.warn(`[dream] Unparseable reply for chunk at #${batch[0]?.id}: ${String(raw).slice(0, 300)}`);
        continue;
      }
      const byId = new Map(batch.map((m) => [m.id, m]));
      for (const v of guardDuplicates(batch, verdicts)) {
        const memory = byId.get(Number(v.id));
        if (!memory) continue; // the model named an id it wasn't given
        const outcome = applyVerdict(memory, v, now, vocabSet);
        result.reviewed++;
        if (outcome === 'pruned') {
          result.pruned++;
          const category = junkCategory(v.category);
          result.prunedBy = { ...result.prunedBy, [category]: (result.prunedBy?.[category] ?? 0) + 1 };
          examples[category] ??= memory.content.replace(/\s+/g, ' ').slice(0, 70);
          // Plain duplicates lose nothing; the rest are judgment calls Artie may want to overrule.
          if (category !== 'duplicate') letGo.push({ id: memory.id, category, userId: letGoOwner(memory) });
        } else {
          for (const t of verdictTags(v)) {
            newTagCounts.set(t, (newTagCounts.get(t) ?? 0) + 1);
          }
        }
        if (outcome === 'tagged') result.tagged++;
      }
    } catch (error) {
      // The model answered; saving its verdicts broke (a DB error). Verdicts already applied stay.
      unsavedChunks++;
      logger.warn(`[dream] Saving verdicts for chunk at #${batch[0]?.id} failed:`, error);
    }
  }

  logger.info(
    `[dream] 💭 Reviewed ${result.reviewed}, tagged ${result.tagged}, pruned ${result.pruned}` +
      ` ${JSON.stringify(result.prunedBy ?? {})} (vocab ${vocab.length})`
  );
  const unreached = Object.fromEntries(unreachedBy);
  if (result.reviewed > 0 || failedChunks > 0 || unreachedBy.size > 0 || unsavedChunks > 0) {
    const topTags = [...newTagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
    writeDreamJournal(
      journalText(
        { ...result, offered: pool.length, failedChunks, unreached, unsavedChunks },
        now
      ),
      result,
      { examples, letGo, topTags }
    );
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Dream journal (EJ, 2026-10-29: "improve his dream recollection"). Artie couldn't say what his
// dream did; now each night leaves one journal memory, and the latest one rides in his context
// for a day and a half (dreamRecallLine), so he remembers without being told.
// ---------------------------------------------------------------------------------------------
const DREAM_JOURNAL_TAG = 'dream-journal';
/** How many non-duplicate prunes the journal names by id (Artie: "here are 5 that weren't plain duplicates"). */
const LET_GO_SHOWN = 5;
const JOURNAL_RECALL_HOURS = 36;

function exampleSuffix(example: string | undefined): string {
  if (!example) return '';
  return ` (e.g. "${example}")`;
}

/** Short, plain cause for a model call that threw. Never the raw message (it can carry URLs/ids). */
export function unreachedReasonFor(error: unknown): string {
  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  if (/OUT OF CREDITS|(?:HTTP|status|code)[ :]*402\b|Payment Required/i.test(message)) return 'the model account was out of credits';
  if (/GENERATION MUTED|kill ?switch/i.test(message)) return 'generation was muted';
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(message)) return 'the model could not be reached';
  return 'the model call errored';
}

function journalDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

export function journalText(
  r: DreamResult & {
    offered: number;
    failedChunks: number;
    /** Batches whose model call threw, counted per plain reason (unreachedReasonFor). */
    unreached?: Record<string, number>;
    /** Batches the model answered but whose verdicts failed to save (DB error mid-batch). */
    unsavedChunks?: number;
  },
  nowIso: string
): string {
  // Counts only. The journal rides in every channel's context, so no memory text or ids from any
  // one person or server go in it; those live in the journal row's metadata (journalDetails).
  const day = journalDay(nowIso);
  const parts = [`Dream journal (${day}): reviewed ${r.reviewed} of ${r.offered} memories, re-tagged ${r.tagged}`];
  if (r.pruned > 0) {
    const cats = Object.entries(r.prunedBy ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${n} ${c}`);
    parts.push(`let go of ${r.pruned} that held nothing worth keeping: ${cats.join(', ')}`);
  } else {
    parts.push('let go of nothing');
  }
  for (const [reason, n] of Object.entries(r.unreached ?? {}).sort((a, b) => b[1] - a[1])) {
    parts.push(
      `${n} batch(es) never got an answer because ${reason}` +
        ` (not a problem with the memories); they wait for the next dream`
    );
  }
  if (r.failedChunks > 0) parts.push(`${r.failedChunks} batch(es) came back unreadable; those memories wait for the next dream`);
  const unsaved = r.unsavedChunks ?? 0;
  if (unsaved > 0) {
    parts.push(`${unsaved} batch(es) were answered but couldn't be fully saved (a database error); the unsaved ones wait for the next dream`);
  }
  return parts.join('; ') + '. Pruned memories are hidden, not deleted.';
}

interface LetGo {
  id: number;
  category: string;
  userId: string;
}

/** What a journal row keeps out of its public text: one example per category, and the
 *  non-duplicate prunes (Artie: "here are 5 that weren't plain duplicates, so I can object"). */
interface JournalDetails {
  examples?: Record<string, string>;
  letGo?: LetGo[];
  /** Topics of the memories kept; drawn from every server, so EJ-only like the examples. */
  topTags?: string[];
}

/**
 * The part of the journal only some viewers may see, and only in private (a DM or the bridge):
 * in a shared channel everyone there reads the reply, not just the person asking. EJ sees the
 * topics, examples and every judgment call; anyone else sees only the calls on their own
 * memories, which they can restore. Pure.
 */
function journalDetails(details: JournalDetails, viewerId: string | undefined, isPrivate = false): string {
  if (!viewerId || !isPrivate) return '';
  const owner = isOwner(viewerId);
  const parts: string[] = [];
  if (owner) {
    if (details.topTags?.length) parts.push(`the memories kept were mostly about ${details.topTags.join(', ')}`);
    const ex = Object.entries(details.examples ?? {}).map(([c, text]) => `${c}${exampleSuffix(text)}`);
    if (ex.length) parts.push(`examples: ${ex.join(', ')}`);
  }
  const mine = (details.letGo ?? []).filter((m) => owner || m.userId === viewerId);
  if (mine.length > 0) {
    const shown = mine.slice(0, LET_GO_SHOWN).map((m) => `#${m.id} ${m.category}`);
    let more = '';
    if (mine.length > LET_GO_SHOWN) more = ` (+${mine.length - LET_GO_SHOWN} more)`;
    let whose = 'theirs';
    if (owner) whose = 'all, EJ can see them';
    parts.push(`judgment calls this person can overrule (${whose}): ${shown.join(', ')}${more}; memory restore id brings one back`);
  }
  return parts.join('; ');
}

export function writeDreamJournal(content: string, result: DreamResult, details: JournalDetails = {}): void {
  try {
    getSyncDb().run(
      `INSERT INTO memories (user_id, content, tags, context, timestamp, importance, metadata)
       VALUES ('artie-system', ?, ?, 'Nightly memory dream', ?, 6, ?)`,
      [
        content,
        JSON.stringify([DREAM_JOURNAL_TAG, 'event']),
        new Date().toISOString(),
        JSON.stringify({ dream: result, dreamt_at: new Date().toISOString(), details }),
      ]
    );
  } catch (error) {
    logger.warn('[dream] Could not write the dream journal:', error);
  }
}

/**
 * The latest dream journal as one context line, while it's fresh; '' otherwise. The counts are
 * for everyone; examples and ids only for the viewer allowed to see them (journalDetails).
 */
export function dreamRecallLine(now: number = Date.now(), viewerId?: string, isPrivate = false): string {
  try {
    const row = getSyncDb().get<{ content: string; timestamp: string; metadata: string | null }>(
      `SELECT content, timestamp, metadata FROM memories WHERE user_id = 'artie-system' AND tags LIKE ? ORDER BY id DESC LIMIT 1`,
      [`%"${DREAM_JOURNAL_TAG}"%`]
    );
    if (!row) return '';
    if (now - Date.parse(row.timestamp) > JOURNAL_RECALL_HOURS * 3_600_000) return '';
    // Journals written before 2026-11-18 carry no `details` and quote memory text in their public
    // content; they are not safe for every channel, so say nothing until tonight's dream.
    let details: JournalDetails | null = null;
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta && typeof meta.details === 'object' && meta.details) details = meta.details;
    } catch {
      details = null;
    }
    if (!details) return '';
    const extra = journalDetails(details, viewerId, isPrivate);
    let tail = '';
    if (extra) tail = ` ${extra}.`;
    // A plain fact, no instructions (EJ: "that's a lot of handholding"). He may riff on a
    // "what did you dream?" anyway; that's his call.
    return `💭 Last night's memory dream: ${row.content.replace(/^Dream journal \([^)]*\): /, '')}${tail}`;
  } catch {
    return '';
  }
}

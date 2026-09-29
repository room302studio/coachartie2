import { logger, getSyncDb, isBlockedUser, estimateTokens } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';

/**
 * stack-talk — ask a cheap long-context model a question over a huge pack of Artie's memories.
 *
 * Artie's normal recall hands the reply model a few hundred tokens of memories; the whole store
 * is ~20k memories / ~3M tokens. stack-talk packs as much of it as the chosen model's window
 * holds (relevance first, then importance and recency) and asks one cheap question. It is an
 * archivist, not an oracle: good at "what do we know about X / who said Y / what happened in
 * July", weak at subtle reasoning across everything (EJ, 2026-09-29; name is his).
 *
 * Models (EJ likes cheap Kimi + Chinese cutting-edge; OpenRouter prices 2026-09-29):
 *   default  moonshotai/kimi-k2.5             262k ctx, $0.45/M in ($0.07 cached) → ~9¢/pack
 *   deep     deepseek/deepseek-v4-flash-0731  1.31M ctx, $0.018/M in             → ~2¢/pack
 * Both configurable (STACK_TALK_MODEL / STACK_TALK_DEEP_MODEL). No fallback onto the Haiku/Sonnet
 * rotation: a 200k-token prompt there would cost dollars. Goes through the normal guards
 * (kill switch, daily cap) and records a 'stack_talk' usage row at OpenRouter's reported cost.
 */

export interface StackTalkScope {
  userId?: string; // only memories about/with this user
  guildId?: string; // only memories from this guild
}

export interface StackTalkRequest {
  question: string;
  askedBy: string;
  scope?: StackTalkScope;
  deep?: boolean;
}

export interface StackTalkResult {
  answer: string;
  model: string;
  packTokens: number;
  memoriesIncluded: number;
  memoriesMatched: number;
  memoriesInScope: number;
}

export interface MemoryRow {
  id: number;
  user_id: string;
  guild_id: string | null;
  content: string;
  timestamp: string;
  importance: number | null;
}

export const DEFAULT_MODEL = 'moonshotai/kimi-k2.5';
export const DEFAULT_DEEP_MODEL = 'deepseek/deepseek-v4-flash-0731';

/** Context windows (tokens) of the models we expect here; unknown models get a safe 128k. */
const KNOWN_CONTEXT: Record<string, number> = {
  'moonshotai/kimi-k2.5': 262_144,
  'moonshotai/kimi-k2.6': 262_144,
  'deepseek/deepseek-v4-flash-0731': 1_310_720,
  'deepseek/deepseek-v4-flash': 1_048_576,
  'qwen/qwen3.7-flash': 1_000_000,
  'qwen/qwen3.8-flash': 1_000_000,
  'minimax/minimax-m3': 1_048_576,
};
const UNKNOWN_CONTEXT = 131_072;

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function contextWindowFor(model: string): number {
  return envInt('STACK_TALK_CONTEXT_TOKENS', KNOWN_CONTEXT[model] ?? UNKNOWN_CONTEXT);
}

/**
 * Tokens available for memories: 80% of the window, minus the answer and the scaffolding
 * (system prompt + question), capped by STACK_TALK_MAX_PACK_TOKENS as a spend ceiling.
 */
export function packBudget(model: string, question: string, maxOutput: number): number {
  const scaffolding = estimateTokens(SYSTEM_PROMPT) + estimateTokens(question) + 200;
  const fromWindow = Math.floor(contextWindowFor(model) * 0.8) - maxOutput - scaffolding;
  return Math.max(0, Math.min(fromWindow, envInt('STACK_TALK_MAX_PACK_TOKENS', 900_000)));
}

const STOPWORDS = new Set(
  'the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get let put say she too use what when where which while with about artie coach does know tell there their them they this that from have been were will would could should into over than then just like also some more most much very your ever'.split(
    ' '
  )
);

/** FTS5 query from a question: distinct keywords OR'd as quoted terms (quotes = no syntax errors). */
export function buildFtsQuery(question: string): string | null {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 24);
  return unique.length ? unique.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ') : null;
}

export function formatMemoryLine(m: MemoryRow): string {
  const date = (m.timestamp || '').slice(0, 10);
  const where = m.guild_id ? ` g:${m.guild_id}` : '';
  const content = m.content.replace(/\s+/g, ' ').trim().slice(0, 2000);
  return `[#${m.id} ${date} u:${m.user_id}${where}] ${content}`;
}

/**
 * Relevance-matched memories first, then the rest (caller orders them by importance/recency),
 * deduped and blocklist-filtered, until the token budget is spent.
 */
export function packMemories(
  matched: MemoryRow[],
  background: MemoryRow[],
  budget: number
): { lines: string[]; tokens: number; matchedIncluded: number } {
  const seen = new Set<number>();
  const lines: string[] = [];
  let tokens = 0;
  let matchedIncluded = 0;
  const take = (rows: MemoryRow[], isMatch: boolean) => {
    for (const m of rows) {
      if (seen.has(m.id) || isBlockedUser(m.user_id) || !m.content?.trim()) continue;
      const line = formatMemoryLine(m);
      const cost = estimateTokens(line) + 1;
      if (tokens + cost > budget) return false;
      seen.add(m.id);
      lines.push(line);
      tokens += cost;
      if (isMatch) matchedIncluded++;
    }
    return true;
  };
  if (take(matched, true)) take(background, false);
  return { lines, tokens, matchedIncluded };
}

const SYSTEM_PROMPT = `You are Coach Artie's archivist. Below is a large dump of Artie's stored memories: notes he wrote about people, conversations and events in the Discord servers he lives in. Each line is [#id date u:user g:guild] text.

Answer the question at the end using ONLY these memories.
- Cite the memories you rely on by id, like [#1234].
- If the memories don't cover it, say so plainly. Don't fill gaps from general knowledge.
- Memories can be stale, wrong or contradict each other; when they conflict, say so and prefer newer ones.
- Be concise and concrete: names, dates, what was said.`;

function scopeSql(scope: StackTalkScope = {}): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (scope.userId) {
    clauses.push('m.user_id = ?');
    params.push(scope.userId);
  }
  if (scope.guildId) {
    clauses.push('m.guild_id = ?');
    params.push(scope.guildId);
  }
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function fetchMatched(question: string, scope?: StackTalkScope): MemoryRow[] {
  const fts = buildFtsQuery(question);
  if (!fts) return [];
  const { where, params } = scopeSql(scope);
  try {
    return getSyncDb().all<MemoryRow>(
      `SELECT m.id, m.user_id, m.guild_id, m.content, m.timestamp, m.importance
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? ${where}
        ORDER BY bm25(memories_fts) LIMIT 5000`,
      [fts, ...params]
    );
  } catch (error) {
    // No FTS table (fresh/test DB) or a query it can't parse: fall back to background order.
    logger.warn('stack-talk: FTS match failed, packing by importance/recency only', error);
    return [];
  }
}

function fetchBackground(scope?: StackTalkScope): MemoryRow[] {
  const { where, params } = scopeSql(scope);
  return getSyncDb().all<MemoryRow>(
    `SELECT m.id, m.user_id, m.guild_id, m.content, m.timestamp, m.importance
       FROM memories m WHERE 1=1 ${where}
      ORDER BY m.importance DESC, m.timestamp DESC`,
    params
  );
}

export async function stackTalk(req: StackTalkRequest): Promise<StackTalkResult> {
  const question = req.question.trim();
  if (!question) throw new Error('stack-talk needs a question');

  const model = req.deep
    ? process.env.STACK_TALK_DEEP_MODEL || DEFAULT_DEEP_MODEL
    : process.env.STACK_TALK_MODEL || DEFAULT_MODEL;
  const maxOutput = envInt('STACK_TALK_MAX_OUTPUT_TOKENS', 2000);

  const matched = fetchMatched(question, req.scope);
  const background = fetchBackground(req.scope);
  const budget = packBudget(model, question, maxOutput);
  const pack = packMemories(matched, background, budget);

  logger.info(
    `📚 stack-talk: ${model}${req.deep ? ' (deep)' : ''} — packing ${pack.lines.length}/${background.length} memories ` +
      `(${pack.matchedIncluded}/${matched.length} keyword matches), ~${pack.tokens} tok of ${budget} budget`
  );

  const messages = [
    { role: 'system' as const, content: `${SYSTEM_PROMPT}\n\n=== MEMORIES ===\n${pack.lines.join('\n')}` },
    { role: 'user' as const, content: `Question: ${question}` },
  ];

  const answer = await openRouterService.generateFromMessageChain(
    messages,
    req.askedBy,
    undefined,
    model,
    {
      stepType: 'stack_talk',
      maxTokens: maxOutput,
      fallbackModels: [], // never onto the Opus/Sonnet rotation with a prompt this size
      reasoning: { effort: process.env.STACK_TALK_REASONING || 'low' },
      timeoutMs: envInt('STACK_TALK_TIMEOUT_MS', 180_000),
    }
  );

  return {
    answer: answer.trim(),
    model,
    packTokens: pack.tokens,
    memoriesIncluded: pack.lines.length,
    memoriesMatched: matched.length,
    memoriesInScope: background.length,
  };
}

/**
 * Reflection as structured JSON (wave 10, ledger Top-5 #3).
 *
 * After a turn, a background call writes down what is worth knowing next time. It used to be
 * a free-text prompt ("In the dialogue I just sent, identify and list...") read from the DB
 * (PROMPT_REFLECTION_GENERAL / PROMPT_REFLECTION_CAPABILITY), wrapped in Artie's full system
 * prompt and that user's recalled memories. Inside his persona the request read like an
 * injection probe, so about a third of the stored "reflections" were Artie answering in
 * character ("Lap eighteen, comrade", "I'm not extracting memorable facts") and the read-time
 * heuristics in memory/legacy-reflection-filter.ts had to hide them.
 *
 * Now the code owns the prompt (the DB rows are no longer read for this call), the call runs
 * as a plain note-taking step with no persona, and the answer is {"facts": string[]}: an empty
 * list means nothing to remember. response_format is sent when the model takes it; the reply
 * is parsed with parseModelJson either way, and anything else stores nothing.
 */
import { logger } from '../../shared/logger.js';
import { parseModelJson } from '../../shared/model-json.js';
import type { JsonOutputSpec } from '../../shared/structured-output.js';
import type { ChatMessage } from '../3-context/prompt-cache.js';
import { openRouterService } from '../4-generate/openrouter.js';

export type ReflectionType = 'general' | 'capability';

/** Marks rows written by this path (a tag), so they skip the legacy in-character filter. */
export const REFLECTION_V3_TAG = 'reflection_v3';

const MAX_FACTS = 8;
const MAX_FACT_CHARS = 300;
/**
 * Room for MAX_FACTS facts plus the JSON around them. The default (LLM_MAX_TOKENS, 400) fit the
 * old bullet list, which was still usable when cut off; a JSON reply cut off mid-array parses
 * to nothing, so the cap has to cover a full answer.
 */
export const REFLECTION_MAX_TOKENS = 800;

export const REFLECTION_OUTPUT: JsonOutputSpec = {
  name: 'reflection_facts',
  schema: {
    type: 'object',
    properties: { facts: { type: 'array', items: { type: 'string' } } },
    required: ['facts'],
    additionalProperties: false,
  },
};

const WHAT_TO_KEEP: Record<ReflectionType, string> = {
  general: `Keep facts that will matter in a later conversation:
- concrete details: numbers, names, dates, URLs, versions, technical specifics
- the user's projects, goals, preferences and circumstances
- decisions made or conclusions reached
Skip greetings, banter, jokes, moods, and anything that only mattered in the moment.`,
  capability: `This turn used tools. Keep lessons that will help the next time a tool is used:
- which tool and which arguments worked
- errors that happened and how they were resolved (or that they were not)
- what to do differently next time
Skip anything that is not about how the tools behaved.`,
};

/**
 * The messages for one reflection call. No persona: this is a record-keeping step, and the
 * turn is quoted as data between tags, never addressed to the model as a conversation.
 */
export function buildReflectionMessages(type: ReflectionType, turnText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You maintain the memory notes for Coach Artie, a Discord bot. After each conversation turn you record what is worth remembering. You are not a participant in the conversation and you are not replying to anyone; your output goes straight into a notes database.

${WHAT_TO_KEEP[type]}

Write each fact as one short, self-contained sentence in the third person ("the user is building a Tokyo save in Subway Builder"). Use a person's name when the turn gives one. Never write about Artie's own personality or replies.

Answer with JSON only, in this shape: {"facts": ["...", "..."]}. If nothing is worth keeping, answer {"facts": []}.`,
    },
    {
      role: 'user',
      content: `<turn>\n${turnText}\n</turn>`,
    },
  ];
}

/**
 * The facts in a reflection reply: trimmed, non-empty strings, at most MAX_FACTS, each capped.
 * [] when the model said there is nothing; null when the reply is not {"facts": [...]}.
 */
export function parseReflectionFacts(raw: string): string[] | null {
  const parsed = parseModelJson<{ facts?: unknown }>(raw, 'object');
  if (!parsed || !Array.isArray(parsed.facts)) return null;
  return parsed.facts
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .slice(0, MAX_FACTS)
    .map((f) => (f.length > MAX_FACT_CHARS ? `${f.slice(0, MAX_FACT_CHARS)}…` : f));
}

/** Facts as one memory row, in the bullet-list shape reflection rows have always had. */
export function formatReflectionNote(facts: string[]): string {
  return facts.map((f) => `- ${f}`).join('\n');
}

/**
 * One reflection call. Always resolves: [] on an empty answer, on an unparseable one (one warn
 * log) and on a failed call (one error log), so a reflection never breaks the turn.
 */
export async function generateReflectionFacts(
  turnText: string,
  type: ReflectionType,
  userId: string,
  /** Conversation key: keeps this conversation's reflections on one model so its cache stays warm. */
  rotationKey?: string
): Promise<string[]> {
  let raw: string;
  try {
    raw = await openRouterService.generateFromMessageChain(
      buildReflectionMessages(type, turnText),
      userId,
      undefined,
      undefined,
      { rotationKey, stepType: 'reflection', jsonOutput: REFLECTION_OUTPUT, maxTokens: REFLECTION_MAX_TOKENS }
    );
  } catch (error) {
    logger.error(`❌ Failed to generate ${type} reflection:`, error);
    return [];
  }
  const facts = parseReflectionFacts(raw);
  if (facts === null) {
    logger.warn(`⚠️ ${type} reflection was not {"facts": [...]}; nothing stored: ${raw.slice(0, 120)}`);
    return [];
  }
  return facts;
}

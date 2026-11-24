/**
 * Clean LLM output: the one place that strips what a model emits but nobody should see.
 *
 *   stripToolCalls       <capability …/>, <capability>…</capability>, and the Anthropic-native
 *                        <function_calls>/<function_results>/<invoke> scaffolding
 *   stripInternalMarkup  reasoning and wrapper blocks (<think>, <thinking>, <wants_loop>,
 *                        <system-reminder>, <security_reminder>, [USER_MESSAGE], [SYSTEM: …],
 *                        <artie>, <recall>, "Step N/M" markers), by name
 *   stripChatPrefixes    role prefixes a reply should never start with ("[artie]:", "**Me:**")
 *   isSilent             [SILENT]: the model chose not to speak
 *
 * Wave 5 folded five hand-rolled strippers into this module: this file's stripCapabilityXML
 * (push-worker's last filter), stream-reply's cleanCapabilityTags, transcript's
 * sanitizeAssistantMessage, recall's stripCapabilityTags and generate-reply's
 * stripThinkingTags/extractLoopDecision. They did not agree (case flags, capability-regex shape,
 * pass order, which tags each knew), and tests/shared/clean-llm-output.test.ts pins each one's
 * output, so every disagreement is an explicit option here rather than a silent unification.
 * The regexes are the old ones, unchanged; waves 7/10 may unify them.
 *
 * Nothing here trims or collapses whitespace: each caller keeps its own (trim, trimEnd,
 * collapse) exactly as before.
 */

// -----------------------------------------------------------------------------
// Tool calls
// -----------------------------------------------------------------------------

/**
 * How <capability> tags are matched. The callers historically differ, and the difference is
 * observable (an attribute containing ">", upper-case tags, a self-closing tag followed by a
 * paired one), so each one names its own.
 *  - 'paired-then-self': paired tags first, then self-closing; case-insensitive (outbound)
 *  - 'self-then-paired': self-closing first, then paired; case-insensitive (history)
 *  - 'self-then-paired-case-sensitive': as above but case-sensitive (stream-reply)
 *  - 'lazy': one case-sensitive pass from "<capability" to the first "/>" or
 *    "</capability>" (recall)
 */
export type CapabilityMatch =
  | 'paired-then-self'
  | 'self-then-paired'
  | 'self-then-paired-case-sensitive'
  | 'lazy';

const CAPABILITY_PASSES: Record<CapabilityMatch, RegExp[]> = {
  'paired-then-self': [/<capability\b[^>]*>[\s\S]*?<\/capability>/gi, /<capability\b[^>]*\/>/gi],
  'self-then-paired': [/<capability\b[^>]*\/>/gi, /<capability\b[^>]*>[\s\S]*?<\/capability>/gi],
  'self-then-paired-case-sensitive': [
    /<capability\b[^>]*\/>/gs,
    /<capability\b[^>]*>[\s\S]*?<\/capability>/gs,
  ],
  lazy: [/<capability\b[\s\S]*?(\/>|<\/capability>)/g],
};

// Anthropic-native tool syntax: models routed through claude-* sometimes slip into
// <function_calls>/<invoke> format instead of <capability> tags. The parser ignores
// it (so nothing executes) and the raw scaffolding was leaking into Discord verbatim.
// An unclosed block is stripped to the end of the text.
const FUNCTION_CALL_PASSES: RegExp[] = [
  /<function_calls>[\s\S]*?(<\/function_calls>|$)/gs,
  /<function_results>[\s\S]*?(<\/function_results>|$)/gs,
  /<invoke\b[^>]*>[\s\S]*?(<\/invoke>|$)/gs,
  /<\/?(?:function_calls|function_results|invoke)>/g,
];

export interface StripToolCallsOptions {
  /** How <capability> tags are matched (default 'self-then-paired'); false skips them. */
  capability?: CapabilityMatch | false;
  /** Also strip <function_calls>/<function_results>/<invoke> (default false). */
  functionCalls?: boolean;
}

/** Remove tool-call markup: capability tags first, then (optionally) function-call blocks. */
export function stripToolCalls(text: string, opts: StripToolCallsOptions = {}): string {
  const { capability = 'self-then-paired', functionCalls = false } = opts;
  let out = text;
  if (capability) {
    for (const re of CAPABILITY_PASSES[capability]) out = out.replace(re, '');
  }
  if (functionCalls) {
    for (const re of FUNCTION_CALL_PASSES) out = out.replace(re, '');
  }
  return out;
}

// -----------------------------------------------------------------------------
// Internal markup
// -----------------------------------------------------------------------------

const INTERNAL_MARKUP = {
  /** <wants_loop> from the retired XML loop: models still slip it, so it never reaches Discord. */
  wants_loop: /<wants_loop>[^<]*<\/wants_loop>/gs,
  think: /<think>[\s\S]*?<\/think>/gs,
  thinking: /<thinking>[\s\S]*?<\/thinking>/gi,
  'system-reminder': /<system-reminder>[\s\S]*?<\/system-reminder>/gs,
  security_reminder: /<security_reminder>[\s\S]*?<\/security_reminder>/gi,
  user_message: /<user_message\b[^>]*>[\s\S]*?<\/user_message>/gi,
  USER_MESSAGE: /\[USER_MESSAGE\][\s\S]*?\[\/USER_MESSAGE\]/gi,
  SYSTEM: /\[SYSTEM:[\s\S]*?(?:\]|→[^\]]*)/g,
  /** <artie> wrapper tags some models add (seen in Llama/Mistral outputs) */
  artie: /<\/?artie>/gi,
  /** the tags only, not their content */
  recall: /<\/?recall\b[^>]*>/g,
  /** "## Step 2/5 …" lines from the multi-step loop */
  'step-markers': /^#{0,3}\s*Step \d+\s*\/\s*\d+.*$/gim,
} as const;

export type InternalMarkup = keyof typeof INTERNAL_MARKUP;

/** Remove the named markup, in the order given (order is part of each caller's behavior). */
export function stripInternalMarkup(text: string, tags: readonly InternalMarkup[]): string {
  let out = text;
  for (const tag of tags) out = out.replace(INTERNAL_MARKUP[tag], '');
  return out;
}

// -----------------------------------------------------------------------------
// Chat prefixes
// -----------------------------------------------------------------------------

const CHAT_PREFIXES = {
  /** a fresh reply (generate-reply) */
  reply: [
    /^\[artie\]:\s*/i,
    /^\*\*Response:\*\*\s*/i,
    /^\*\*Me:\*\*\s*/i,
    /^\*\*Artie:\*\*\s*/i,
    /^\*\*Coach Artie:\*\*\s*/i,
  ],
  /**
   * a stored assistant turn replayed as history (transcript): formats the model should NEVER
   * use, so they are stripped from history before they teach the next generation
   */
  history: [
    /^\*\*Me:\*\*\s*/i,
    /^\*\*Artie:\*\*\s*/i,
    /^\*\*Coach Artie:\*\*\s*/i,
    /^\*\*Response:\*\*\s*/i,
    /^\*\*Reply:\*\*\s*/i,
    /^\*\*Review:\*\*\s*/i,
    /^\*\*Analysis:\*\*\s*/i,
    /^\*\*Answer:\*\*\s*/i,
    /^\*\*Explanation:\*\*\s*/i,
    /^Response to (your |the )?message:\s*/i,
    /^Response to user:\s*/i,
    /^Here's my response:\s*/i,
  ],
} as const;

/** Remove leading role prefixes, each pattern once, in order. */
export function stripChatPrefixes(text: string, set: keyof typeof CHAT_PREFIXES): string {
  let out = text;
  for (const re of CHAT_PREFIXES[set]) out = out.replace(re, '');
  return out;
}

// -----------------------------------------------------------------------------
// [SILENT]
// -----------------------------------------------------------------------------

/**
 * [SILENT]: the model chose not to speak. A LEADING marker (after whitespace, any case)
 * silences the whole reply even if chatter follows; that is the check every delivery path
 * makes. `exact: true` is the engine's storage filter, which only skips a reply that is
 * nothing BUT the marker (so "[SILENT] chatter" is still stored as a turn).
 */
export function isSilent(text: string, opts: { exact?: boolean } = {}): boolean {
  if (opts.exact) return text.trim() === '[SILENT]' || text.trim().toLowerCase() === '[silent]';
  return /^\s*\[SILENT\]/i.test(text);
}

/** Remove every [SILENT] marker, any case (no trimming). */
export function stripSilentMarkers(text: string): string {
  return text.replace(/\[SILENT\]/gi, '');
}

// -----------------------------------------------------------------------------
// The outbound last-line filter
// -----------------------------------------------------------------------------

/**
 * CRITICAL SECURITY: Strip capability XML tags from text before sending to Discord
 *
 * Capability tags like <capability name="tts" action="sing">...</capability>
 * should NEVER appear in Discord messages - they must be processed first.
 *
 * This is a safeguard against accidentally leaking capability XML when messages
 * are sent via non-standard paths (direct Discord API calls, webhooks, etc.)
 */
export function stripCapabilityXML(text: string): string {
  if (!text) return text;

  // Paired <capability…>…</capability> tags first (multiline), then self-closing ones.
  const stripped = stripToolCalls(text, { capability: 'paired-then-self' });

  // Log if we stripped anything (this should trigger investigation)
  if (stripped !== text) {
    console.error('🚨 CAPABILITY XML LEAKED TO DISCORD - STRIPPED IT:', {
      original_length: text.length,
      stripped_length: stripped.length,
      removed_chars: text.length - stripped.length
    });
  }

  return stripped.trim();
}


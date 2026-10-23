/**
 * Output safety: the patterns that suppress a message outright (slur floor, prompt-scaffolding
 * leaks), and the hedge phrases that mark an observation summary as a non-event. Kept as
 * regex; only the location moved (wave 5, out of stream-reply.ts and observe-channels.ts).
 */

// OUTPUT SAFETY FLOOR: genuine slurs / hate terms that must NEVER reach a channel, even in
// roast mode. If a reply matches, the message is suppressed (Artie stays silent) rather than
// posted. Word-boundaried + case-insensitive. Profanity is intentionally NOT here — roasts can
// swear; this is only the "bad ones."
export const OUTPUT_SLUR_BLOCKLIST =
  /\b(n[i1]gg(?:er|a|ah)|f[a4]gg?(?:ot|y)?|retard(?:ed|s)?|k[i1]ke|sp[i1]c|ch[i1]nk|g[o0]ok|tr[a4]nny|wetback|coon|beaner|dyke|sand[\s-]?n[i1]gg|porch[\s-]?monkey)\b/i;

// OUTPUT SAFETY: never let prompt scaffolding / internal context leak into a channel message.
// (He once dumped "Pinned memory:", his instruction text, and the [CURRENT MESSAGE] wrapper.)
export const INTERNAL_LEAK_BLOCKLIST =
  /\[CURRENT MESSAGE\]|Remember:\s*You are Coach Artie|Pinned memory:|Don.?t echo any XML|\(ID:\s*\d{5,}\)|<\/?capability\b|<calc\b/i;

/**
 * Shared output safety floor for anything Artie posts OUTSIDE the normal reply
 * pipeline (e.g. scheduled launch-countdown posts). Same rule as replies:
 * a match means suppress the message entirely, never post a censored version.
 */
export function violatesOutputSafety(text: string): boolean {
  return OUTPUT_SLUR_BLOCKLIST.test(text) || INTERNAL_LEAK_BLOCKLIST.test(text);
}

/**
 * Hedge phrases (watchers/observe-channels.ts isNonEventSummary): "An LLM concluded there was
 * nothing to remember" — don't store that as a memory.
 */
export const NON_EVENT_PATTERNS = [
  /\bno (specific|notable|significant|relevant|meaningful|particular|clear)\b/i,
  /\bno correlations?\b/i,
  /\bnothing (notable|significant|of note|relevant|meaningful|to (note|report|remember))\b/i,
  /\b(were|was) not (mentioned|discussed|observed)\b/i,
  /\binsufficient (information|context|data)\b/i,
];

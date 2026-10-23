import { logger } from '../../shared/logger.js';

/**
 * Which tool loop a turn runs (wave 8, F3).
 *
 *   native (default)  OpenRouter/OpenAI `tools` + `tool_calls`, runToolLoop (native-loop.ts).
 *   xml               TOOL_LOOP=xml: the old path end to end — the XML roster and format
 *                     teaching in the system prompt, the <capability/> parser, <wants_loop>,
 *                     the llm-loop ReAct loop, {{var}} substitution and the `variable` tool.
 *                     XML-LOOP: delete after v3 soak (TOOL_LOOP=xml)
 *
 * TOOL_LOOP=xml is the ONE emergency flag and exists only until v3 has soaked. Rollback is
 * `TOOL_LOOP=xml` in the environment + a restart. This getter is the only reader of the
 * variable; it reads it on every call, so a test can flip it after import.
 */
export type ToolLoopMode = 'native' | 'xml';

let warnedUnknown = false;

export function toolLoopMode(): ToolLoopMode {
  const raw = (process.env.TOOL_LOOP ?? '').trim().toLowerCase();
  if (raw === 'xml') return 'xml'; // XML-LOOP: delete after v3 soak (TOOL_LOOP=xml)
  if (raw && raw !== 'native' && !warnedUnknown) {
    warnedUnknown = true;
    logger.warn(`TOOL_LOOP="${raw}" is not 'native' or 'xml'; using native`);
  }
  return 'native';
}

/** The one line native mode adds to the system prompt (spec §5). */
export const NATIVE_TOOLS_LINE = 'Use the provided tools; never write <capability> tags.';

/**
 * Tools that exist only as XML plumbing and are never offered as native tools.
 * `variable` carries values between <capability/> tags ({{var}}); native tool results come
 * back to the model directly.
 */
export const XML_ONLY_TOOLS = new Set(['variable']); // XML-LOOP: delete after v3 soak (TOOL_LOOP=xml)

/** Header of the XML-mode roster (system-prompt.ts buildCapabilityRoster). */
export const ROSTER_HEADER = '## Your capability roster';

const ATTR = /([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Attribute name → value, in source order, from the inside of a <capability ...> tag. */
export function parseTagAttributes(attrText: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of attrText.matchAll(ATTR)) out.push([m[1], m[2] ?? m[3] ?? '']);
  return out;
}

function callNotation(attrText: string, body?: string): string {
  const attrs = parseTagAttributes(attrText);
  const name = attrs.find(([k]) => k === 'name')?.[1] ?? 'tool';
  const args = attrs
    .filter(([k]) => k !== 'name')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  const trimmed = body?.trim();
  if (trimmed) args.push(`content=${JSON.stringify(trimmed)}`);
  return `${name}(${args.join(', ')})`;
}

/**
 * Rewrite <capability .../> and <capability ...>body</capability> examples as call notation,
 * `web(action="search", query="x")`: the same information (tool, action, argument names),
 * without teaching the tag syntax. A tag body becomes the `content` argument, which is where
 * the native tool schema puts it.
 *
 * Input is trusted static text (tool descriptions, DB prompts, registry error hints), never
 * model output. Self-closing tags go first: the paired pattern's `[^>]*` would otherwise also
 * swallow a self-closing tag's `/` and pair it with a later closing tag.
 */
export function toCallNotation(text: string): string {
  if (!text.includes('<capability')) return text;
  return text
    .replace(SELF_CLOSING_TAG, (_m, attrs: string) => callNotation(attrs))
    .replace(PAIRED_TAG, (_m, attrs: string, body: string) => callNotation(attrs, body));
}

/**
 * A tag's attribute text: quoted values may contain `>` (`participants="<@123>"`), so a quoted
 * string is consumed whole; anything else stops at `>`. Each alternative starts with a
 * different character, so matching stays linear.
 */
export const TAG_ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;
const SELF_CLOSING_TAG = new RegExp(`<capability\\b${TAG_ATTRS}\\s*\\/>`, 'g');
const PAIRED_TAG = new RegExp(`<capability\\b${TAG_ATTRS}>([\\s\\S]*?)<\\/capability>`, 'g');

/**
 * XML-LOOP: delete after v3 soak (TOOL_LOOP=xml), once the DB prompt rows are cleaned too
 * (BUILD-LOG wave 8 has the SQL): this only exists because those rows still teach XML.
 * Native-mode system prompt clean-up, by marker (spec §5). The live DB prompts can carry XML
 * tool teaching (PROMPT_DISCORD_UI_MODALITY's `Use: <capability name="discord-ui" .../>`
 * lines, tool examples). This:
 *  - drops the XML roster section if one is present ("## Your capability roster" to the next
 *    heading or the end);
 *  - drops any line that mentions <wants_loop>;
 *  - rewrites <capability> examples as call notation (toCallNotation).
 * Deterministic, so the cached prefix stays byte-stable. A no-op on text with no markers.
 */
export function stripXmlToolTeaching(text: string): string {
  if (!text.includes('<capability') && !text.includes('wants_loop') && !text.includes(ROSTER_HEADER)) {
    return text;
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let inRoster = false;
  for (const line of lines) {
    if (line.startsWith(ROSTER_HEADER)) {
      inRoster = true;
      continue;
    }
    if (inRoster) {
      if (/^#{1,6} /.test(line)) inRoster = false;
      else continue;
    }
    if (line.includes('wants_loop')) continue;
    kept.push(line);
  }
  return toCallNotation(kept.join('\n')).replace(/\n{3,}/g, '\n\n');
}

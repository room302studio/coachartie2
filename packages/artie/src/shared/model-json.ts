/**
 * Parse JSON out of a model reply (ledger #7).
 *
 * Replaces the regex scrapes: greedy /\{[\s\S]*\}/ ran from the first '{' to the LAST '}'
 * in the reply, so trailing prose with a '}' broke it; /\[[\s\S]*?\]/ stopped at the first
 * ']' and broke on nested arrays; /\[.*?\]/ had no s flag and missed multi-line arrays.
 *
 * Order: the whole reply as JSON, then the first ```json fenced block, then a
 * balanced-bracket scan (string- and escape-aware) from each '{' or '[' in turn, returning
 * the first span that parses. `expect` limits the result (and the scan's openers) to an
 * object or an array, so a reply like {"tags":[...]} can still yield the array when the
 * caller wants one. Returns null when nothing fits.
 */
export type ModelJsonShape = 'object' | 'array';

const MAX_SCAN_STARTS = 50;

function fits(value: unknown, expect?: ModelJsonShape): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (expect === 'array') return Array.isArray(value);
  if (expect === 'object') return !Array.isArray(value);
  return true;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** End index (inclusive) of the balanced span opening at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export function parseModelJson<T = unknown>(raw: string, expect?: ModelJsonShape): T | null {
  if (!raw) return null;
  const text = raw.trim();

  const whole = tryParse(text);
  if (fits(whole, expect)) return whole as T;

  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (fits(inner, expect)) return inner as T;
  }

  const openers = expect === 'object' ? '{' : expect === 'array' ? '[' : '{[';
  let starts = 0;
  for (let i = 0; i < text.length && starts < MAX_SCAN_STARTS; i++) {
    if (!openers.includes(text[i])) continue;
    starts++;
    const end = balancedEnd(text, i);
    if (end === -1) continue;
    const value = tryParse(text.slice(i, end + 1));
    if (fits(value, expect)) return value as T;
  }
  return null;
}

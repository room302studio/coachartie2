/**
 * self-stats rules (Artie 2026-11-21): "not knowing which version of my rules is actually live."
 * The banlist riddles came from a database prompt overriding the code copy while his own notes
 * still said the old thing, and he followed the strictest source. This shows the live prompt
 * versions, what changed lately (lines removed and added), and his own notes that still echo a
 * removed line, so he can fix or drop them. Deterministic, no model call: candidates, not verdicts.
 */
import { getSyncDb } from '../../../shared/db/client.js';
import { isOwner } from '../../../shared/config/owner.js';
import { SELF_VISIBLE_SQL, selfVisibleParams } from '../core/memory.js';

export const CHANGED_WINDOW_DAYS = 30;
const MAX_CANDIDATES = 8;
const LINE_CAP = 300;
const SNIPPET = 160;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LivePrompt {
  name: string;
  version: number;
  content: string;
  updatedAt: string; // SQLite UTC 'YYYY-MM-DD HH:MM:SS'
  previous: string | null; // content of the version before, from prompt_history
}

export interface Note {
  id: number;
  content: string;
  importance: number;
}

export interface Candidate {
  id: number;
  importance: number;
  echoes: string[];
  snippet: string;
}

// Common words that say nothing about which rule a note follows.
const STOP = new Set([
  'always', 'anyone', 'before', 'because', 'cannot', 'should', 'something', 'someone', 'their',
  'there', 'these', 'thing', 'things', 'those', 'through', 'unless', 'where', 'which', 'while',
  'without', 'would', 'about', 'again', 'other', 'others', 'people', 'person', 'never', 'every',
  'users', 'friend', 'message', 'messages', 'answer', 'reply', 'replies',
]);

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Lines only in `before` (removed) and only in `after` (added), order kept. Pure. */
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = new Set(lines(before));
  const b = new Set(lines(after));
  return {
    removed: lines(before).filter((l) => !b.has(l)),
    added: lines(after).filter((l) => !a.has(l)),
  };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z'-]{5,}/g) ?? []);
}

/**
 * What a note following a removed rule would likely contain: quoted phrases from removed lines,
 * and distinctive words (6+ letters, not stopwords) that the added lines don't use. Pure.
 */
export function staleCues(removed: string[], added: string[]): { phrases: string[]; words: string[] } {
  const addedText = added.join('\n').toLowerCase();
  const addedWords = words(addedText);
  const phrases = new Set<string>();
  for (const line of removed) {
    for (const m of line.matchAll(/["“]([^"”]{4,60})["”]/g)) {
      const p = m[1].trim().toLowerCase();
      if (!addedText.includes(p)) phrases.add(p);
    }
  }
  const cueWords = [...words(removed.join('\n'))].filter((w) => !addedWords.has(w) && !STOP.has(w));
  return { phrases: [...phrases], words: cueWords };
}

/** Notes that echo a quoted phrase, or at least two distinctive words, of a removed rule. Pure. */
export function conflictCandidates(notes: Note[], cues: { phrases: string[]; words: string[] }): Candidate[] {
  const scored: Array<Candidate & { score: number }> = [];
  for (const n of notes) {
    const lower = n.content.toLowerCase();
    const phraseHits = cues.phrases.filter((p) => lower.includes(p));
    const noteWords = words(lower);
    const wordHits = cues.words.filter((w) => noteWords.has(w));
    if (phraseHits.length === 0 && wordHits.length < 2) continue;
    let snippet = n.content.replace(/\s+/g, ' ').trim();
    if (snippet.length > SNIPPET) snippet = `${snippet.slice(0, SNIPPET)}…`;
    scored.push({
      id: n.id,
      importance: n.importance,
      echoes: [...phraseHits.map((p) => `"${p}"`), ...wordHits],
      snippet,
      score: phraseHits.length * 3 + wordHits.length,
    });
  }
  scored.sort((x, y) => y.score - x.score || y.id - x.id);
  return scored.slice(0, MAX_CANDIDATES).map(({ score: _score, ...c }) => c);
}

function cap(line: string): string {
  if (line.length > LINE_CAP) return `${line.slice(0, LINE_CAP)}…`;
  return line;
}

function sqliteUtcMs(s: string): number {
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

/**
 * The report. Pure: prompts and notes come in, text goes out. Prompt wording (the diffs) shows
 * only when `showDiffs` (EJ asking): anyone can make Artie call this, and the security prompt's
 * exact wording shouldn't be one call away for a stranger (review 2026-11-21). Everyone gets the
 * versions, dates, and Artie's own visible notes that look stale.
 */
export function rulesReport(
  prompts: LivePrompt[],
  notes: Note[],
  now: Date = new Date(),
  showDiffs = true
): string {
  const out: string[] = ['## Live rules', ''];
  out.push('Database prompts (these override the copies in code):');
  for (const p of prompts) out.push(`- ${p.name} v${p.version}, changed ${p.updatedAt.slice(0, 10)}`);

  const cutoff = now.getTime() - CHANGED_WINDOW_DAYS * DAY_MS;
  const changed = prompts.filter((p) => p.previous !== null && sqliteUtcMs(p.updatedAt) >= cutoff);
  out.push('', `## Changed in the last ${CHANGED_WINDOW_DAYS} days`);
  if (changed.length === 0) {
    out.push('Nothing. Your prompts are as they were a month ago.');
    return out.join('\n');
  }
  if (!showDiffs) {
    out.push(`${changed.map((p) => p.name).join(', ')}. The exact wording shows only when EJ asks; your prompt this turn already has the live version.`);
  }
  // Cues per prompt (review 2026-11-21): a rule that moved from one prompt to another keeps its
  // cue words, and words still used anywhere in that prompt don't count as stale.
  const phrases = new Set<string>();
  const cueWords = new Set<string>();
  for (const p of changed) {
    const { removed, added } = lineDiff(p.previous ?? '', p.content);
    if (showDiffs) {
      out.push(`### ${p.name}, now v${p.version} (${p.updatedAt.slice(0, 10)})`);
      for (const l of removed) out.push(`- removed: ${cap(l)}`);
      for (const l of added) out.push(`+ now: ${cap(l)}`);
      if (removed.length === 0 && added.length === 0) out.push('(whitespace only)');
    }
    const cues = staleCues(removed, [p.content]);
    for (const c of cues.phrases) phrases.add(c);
    for (const w of cues.words) cueWords.add(w);
  }

  const candidates = conflictCandidates(notes, { phrases: [...phrases], words: [...cueWords] });
  out.push('', '## Your notes that may still follow a removed line');
  if (candidates.length === 0) {
    let hint = 'compare your notes with your prompt this turn';
    if (showDiffs) hint = 'read the changes above too';
    out.push(`None found. (This matches words, so ${hint}.)`);
    return out.join('\n');
  }
  for (const c of candidates) {
    // The echoes quote removed prompt wording, so they show only with the diffs (review r2).
    let echoes = '';
    if (showDiffs) echoes = ` echoes ${c.echoes.join(', ')}`;
    out.push(`- #${c.id} (importance ${c.importance})${echoes}: ${c.snippet}`);
  }
  out.push('', 'The live prompt wins. For each one that is really stale: memory forget it, or remember a corrected note. A match is a hint, not proof.');
  return out.join('\n');
}

/** Live prompts plus their previous versions, and the self-notes this viewer may see here. */
export function loadRulesReport(viewerId: string, guildId?: string, now: Date = new Date()): string {
  const db = getSyncDb();
  const prompts = db.all<{ id: number; name: string; version: number; content: string; updated_at: string }>(
    `SELECT id, name, version, content, updated_at FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC, name`
  );
  const live: LivePrompt[] = prompts.map((p) => {
    const prev = db.get<{ content: string }>(
      `SELECT content FROM prompt_history WHERE prompt_id = ? AND version < ? ORDER BY version DESC, id DESC LIMIT 1`,
      [p.id, p.version]
    );
    let previous: string | null = null;
    if (prev) previous = prev.content;
    return { name: p.name, version: p.version, content: p.content, updatedAt: p.updated_at, previous };
  });
  // His self-notes under the same audience rule as everywhere else (memory.ts SELF_VISIBLE_SQL):
  // self-notes carry their audience in metadata, not guild_id, which is always NULL for them.
  let guild: string | null = null;
  if (guildId) guild = guildId;
  const notes = db.all<Note>(
    `SELECT id, content, importance FROM memories WHERE ${SELF_VISIBLE_SQL}`,
    selfVisibleParams(viewerId, guild)
  );
  return rulesReport(live, notes, now, isOwner(viewerId));
}

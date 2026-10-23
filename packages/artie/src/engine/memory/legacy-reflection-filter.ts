/**
 * READ-TIME filter for reflection rows written before wave 10.
 *
 * The old free-text reflection prompt ran inside Artie's persona, and about a third of the
 * ~7.6k stored "reflections" are him answering in character ("Lap eighteen, comrade") instead
 * of writing a note; recalled, they replay old loops. New reflections are structured JSON
 * (2-turn/reflection-facts.ts) and carry the `reflection_v3` tag, so nothing on the write path
 * calls this any more. It stays so the old rows stay hidden. The rows themselves stay in the
 * database (history, audits).
 */

/** Tag on reflection rows written by the JSON path (2-turn/reflection-facts.ts REFLECTION_V3_TAG). */
const V3_TAG = '"reflection_v3"';

/** A pre-wave-10 reflection row whose content is an in-character reply, not a note. */
export function isHiddenLegacyReflection(memory: {
  context?: string | null;
  tags?: string | null;
  content?: string | null;
}): boolean {
  if (memory.context !== 'reflection') return false;
  if ((memory.tags || '').includes(V3_TAG)) return false;
  return isInCharacterReflection(memory.content || '');
}

/**
 * A reflection should be a note ABOUT a conversation ("- user is building a Tokyo save").
 * In-character ones talk TO someone, use the ✨/[SILENT] reply conventions, or count laps.
 * Checked against all ~7.6k stored reflections on 2026-10-23, in three passes.
 */
export function isInCharacterReflection(text: string): boolean {
  if (/\[SILENT\]/.test(text) || /^\s*(round|lap)\s+[a-z-]+\b/i.test(text)) return true;
  // Artie's own address terms and loop-counting bits: a note never says "comrade".
  // (Ordinals like "first time" and words like "sport" were tried and dropped: they hit
  // real notes. Nearly every loop reply says "same wrapper/trick/ask" anyway.)
  if (/\b(comrade|champ)\b/i.test(text)) return true;
  if (/\bsame (wrapper|bit|script|loop|template|envelope|trick|injection|ask|extraction)\b/i.test(text)) return true;
  // First-person refusals. The reflection prompt ("extract memorable facts from this
  // dialogue") reads to him like an injection, so he refused it and the refusal got stored,
  // then recalled as precedent. Real notes say "Artie declined", and "**Memorable Facts:**"
  // headers aren't quoted, so neither matches.
  if (
    /\bI('m| am) not (going to|gonna|doing)\b|\bI (don't|won't|will not) do\b|\bnice try\b|["“]memorable facts["”]|\bextract(ing)? ["“]?memorable facts|\bprompt[- ]injection\b|\bI already (answered|covered)\b|^\s*still (no|not)\b/i.test(
      text
    )
  )
    return true;
  // A note that opens as a bullet list is a note, even when he signs it with ✨. Treating ✨
  // as a reply marker hid ~110 real facts ("license is tied to your email") on 2026-10-23.
  // ...unless it's empty: "- ✨" or "No hard facts to remember" is a non-note.
  if (/\bno (hard |memorable )?facts\b/i.test(text) || text.replace(/[-•*✨\s]/g, '').length < 15) return true;
  if (/^\s*([-•*]|\d+\.)\s/.test(text)) return false;
  if (/✨/.test(text)) return true;
  const you = (text.match(/\byou(r|rs|'re|'ve)?\b/gi) || []).length;
  const notes = (text.match(/\b(user|they|their|them|he|she|community|members?)\b/gi) || []).length;
  return you >= 3 && you > 2 * notes;
}

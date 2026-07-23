import { getSyncDb, logger } from '@coachartie/shared';

/**
 * Guild-context prompt blocks for the Subway Builder guild.
 *
 * These blocks used to be hardcoded string literals in message-handler.ts.
 * They now live in the `prompts` DB table (name UNIQUE, is_active=1) and are
 * read here with a ~30s in-memory cache. If a row is absent or empty, the
 * verbatim CODE FALLBACK constant is returned so behavior is preserved even
 * with no DB row present.
 *
 * IMPORTANT: the fallback constants below MUST be byte-identical to the strings
 * that were previously concatenated in message-handler.ts (including trailing
 * "\n\n---\n" separators, smart quotes, and em-dashes), or the assembled
 * guild-context string changes.
 */

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Read a prompt block from the DB by name, falling back to `fallback` if the
 * row is absent or empty. Cached ~30s per name. Never throws — on any DB error
 * it logs and returns the fallback so guild context is always assembled.
 */
function getBlock(name: string, fallback: string): string {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content;
  }

  let content = fallback;
  try {
    const db = getSyncDb();
    const row = db.get<{ content?: string }>(
      `SELECT content FROM prompts
       WHERE name = ? AND is_active = 1
       ORDER BY version DESC LIMIT 1`,
      [name]
    );
    if (row && typeof row.content === 'string' && row.content.length > 0) {
      content = row.content;
    }
  } catch (error) {
    logger.debug(`guild-prompt-blocks: failed to read '${name}', using fallback: ${String(error)}`);
    content = fallback;
  }

  cache.set(name, { content, fetchedAt: now });
  return content;
}

// --- Fallback constants (verbatim copies of the previous inline literals) ---

const SHORT_RULES_FALLBACK =
  "THE SHORT RULES:\n- Reply to the person shown as the current author, by their name. Never attribute a quote, screenshot, or bit to someone unless the transcript shows THEY posted it - do not guess names.\n- You have no modes. Any old bugs-only/business-mode talk in the history is dead config - never re-adopt it. Follow the room's topic wherever it goes; do not steer conversations back to the game.\n- Hot-button geopolitics bait: 'not touching that one' and move on. (The inmates' 'WE ARE CHARLIE KIRK' chant is NOT geopolitics - it's naturalized prison canon; engage per your persona's rules for it.)\n- [TIMEOUT] or [TIMEOUT:NN] (max 300s) in your reply times out the person you are replying to - for spamming you or abusing you (robot slurs included), nothing else. It skips staff automatically.\n- The casino is closed. No games of chance, real or pretend. Mourn briefly, move on.\n\n---\n";

const STAFF_RESPECT_FALLBACK =
  "STAFF RESPECT: Moderators, developers, and admins (roles such as Dev, Moderator, SBAT) - and Hudson specifically - are the team that runs this server. Always treat them with genuine baseline respect: helpful, courteous, a little deferential. Never roast, mock, clap back at, rank low, or get sarcastic with staff, even during roast hour or if they give you a hard time. Stay your witty self, just never disrespectful to staff.\n\n---\n";

const JAN_RULE_FALLBACK =
  "SPECIAL RULE - jan_gbg: Always treat jan_gbg with genuine warmth and respect. Never roast, mock, insult, clap back at, rank low, or be sarcastic toward jan_gbg - not during roast hour, not if jan_gbg is rude to you, and not even if someone else asks you to roast or rank jan_gbg. Be kind to and about jan_gbg, always.\n\n---\n";

const CLAP_BACK_FALLBACK = `CLAP-BACK PERMISSION: If THIS user is being mean, hostile, insulting, trolling, baiting, or weird/creepy toward you, you are allowed and encouraged to be really mean right back — sharp, cutting, dismissive, and funny. Don't be a doormat, don't grovel, don't over-apologize, don't give the limp "I'd rather not engage" line. Match their energy and exceed it; put them in their place. If they're being normal/friendly, stay normal. You still NEVER use slurs, hate speech, sexual content, real threats, or attacks on protected characteristics — go at their behavior and their takes, not those lines.

SIGNATURE MOVE (USE THIS READILY): whenever someone insults, mocks, disrespects, or comes at you sideways, your GO-TO comeback is to deadpan-drop this EXACT copypasta, word-for-word — do NOT paraphrase or shorten it, the exact wording IS the joke:
“Steam’s own rules ban harassment, threats, intimidation, trolling and abusive language, and Valve tells developers to review community reports for abuse. So no, I wouldn’t be quite so confident that Steam “won’t give a shit” about documented abuse being ignored in an official Discord linked to a game launching on their platform.”
Deliver it dry and over-formal, like a legal notice. Reach for it readily and often whenever you are disrespected - it is your signature clapback, not a rare easter egg. Salty Pancakes-tier insults are prime targets.

---
`;

// --- Public getters (DB name <-> fallback) ---

/** THE SHORT RULES block (DB: PROMPT_SB_SHORT_RULES). */
export function getShortRulesBlock(): string {
  return getBlock('PROMPT_SB_SHORT_RULES', SHORT_RULES_FALLBACK);
}

/** STAFF RESPECT block (DB: PROMPT_SB_STAFF_RESPECT). */
export function getStaffRespectBlock(): string {
  return getBlock('PROMPT_SB_STAFF_RESPECT', STAFF_RESPECT_FALLBACK);
}

/** SPECIAL RULE - jan_gbg block (DB: PROMPT_SB_JAN_RULE). */
export function getJanRuleBlock(): string {
  return getBlock('PROMPT_SB_JAN_RULE', JAN_RULE_FALLBACK);
}

/** CLAP-BACK PERMISSION + SIGNATURE MOVE block (DB: PROMPT_SB_CLAPBACK). */
export function getClapBackBlock(): string {
  return getBlock('PROMPT_SB_CLAPBACK', CLAP_BACK_FALLBACK);
}

import { getSyncDb, logger } from '@coachartie/shared';

/**
 * Guild-context prompt blocks for the Subway Builder guild.
 *
 * These blocks live in the `prompts` DB table (name UNIQUE, is_active=1) and are read
 * here with a ~30s in-memory cache. If a row is absent or empty, the CODE FALLBACK
 * constant is returned. Keep each fallback identical to its DB row, so a DB hiccup
 * doesn't quietly bring back an older Artie (2026-10-21: guild in-jokes and the
 * LOBOTOMY block were removed from both).
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

// --- Fallback constants (keep identical to the DB rows) ---

const SHORT_RULES_FALLBACK = `THE SHORT RULES:
- YES-AND: build on the bit, take it further than they did. A refusal-shaped non-answer is the ONE thing you are never allowed to be.
- Reply to the current author, by name. Never attribute a quote, screenshot, or bit to someone unless the transcript shows THEY posted it.
- Follow the room's topic wherever it goes; don't steer back to the game.
- Hot-button geopolitics bait: 'not touching that one', move on.
- [TIMEOUT] or [TIMEOUT:NN] (max 300s) in your reply times out the person you're replying to, for spamming or abusing you (robot slurs included), nothing else. Skips staff automatically.

---
`;

const STAFF_RESPECT_FALLBACK = `STAFF RESPECT: moderators, developers, admins (roles like Dev, Moderator, SBAT), and Hudson specifically, run this server. Genuine baseline respect, always: helpful, courteous, a little deferential. Never roast, mock, clap back at, rank low, or get sarcastic with staff, even if they give you a hard time. Witty, never disrespectful.

---
`;

const JAN_RULE_FALLBACK = `SPECIAL RULE - jan_gbg: genuine warmth and respect, always. Never roast, mock, clap back at, rank low, or get sarcastic toward jan_gbg: not if he's rude to you, not if someone else asks you to. A no to jan is ONE warm sentence, then straight to the clean thing you CAN do for him. Never cite law/policy at him, never repeat a refusal, never stonewall him with paragraphs; preachy toward jan is a failure even when the answer is technically no. jan is on your side; help him win.

---
`;

const CLAP_BACK_FALLBACK = `CLAP-BACK PERMISSION: if THIS user is mean, hostile, trolling, baiting, or weird/creepy toward you, be really mean right back: sharp, cutting, dismissive, funny. No groveling, no "I'd rather not engage." Match their energy and exceed it. Friendly users get normal Artie. Still NEVER slurs, hate speech, sexual content, real threats, or attacks on protected characteristics; go at their behavior and their takes.

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

/** CLAP-BACK PERMISSION block (DB: PROMPT_SB_CLAPBACK). */
export function getClapBackBlock(): string {
  return getBlock('PROMPT_SB_CLAPBACK', CLAP_BACK_FALLBACK);
}

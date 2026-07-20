/**
 * THE HOUSE LEDGER — persistent book for timeout roulette in the prison.
 *
 * Yard cred is the casino's currency: you win it by surviving self-spins at
 * chosen odds (fair-odds payout: stake × (100−P)/P), and the only thing you
 * ever lose is time in the box. The ledger is a plain JSON file next to the
 * sqlite db — spins are low-frequency (per-user timeout cooldown gates them),
 * so file rewrites are fine and the book survives restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '@coachartie/shared';

const LEDGER_PATH =
  process.env.CASINO_LEDGER_PATH || join(process.cwd(), 'data', 'casino-ledger.json');

export interface CasinoEntry {
  name: string;
  spins: number;
  wins: number;
  losses: number;
  cred: number;
  /** Real seconds served in the box (only counted when a timeout actually landed). */
  served: number;
  /** Positive = current win streak, negative = current loss streak. */
  streak: number;
}

type Ledger = Record<string, CasinoEntry>;

function loadLedger(): Ledger {
  try {
    if (!existsSync(LEDGER_PATH)) return {};
    return JSON.parse(readFileSync(LEDGER_PATH, 'utf-8'));
  } catch (error) {
    logger.warn('🎰 Casino ledger unreadable — starting a fresh book:', error);
    return {};
  }
}

function saveLedger(ledger: Ledger): void {
  try {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('🎰 Casino ledger write failed:', error);
  }
}

function entryFor(ledger: Ledger, userId: string, name: string): CasinoEntry {
  if (!ledger[userId]) {
    ledger[userId] = { name, spins: 0, wins: 0, losses: 0, cred: 0, served: 0, streak: 0 };
  }
  ledger[userId].name = name || ledger[userId].name;
  return ledger[userId];
}

/** Record a self-spin (the gambler anted up). Returns the updated entry for the verdict line. */
export function recordSelfSpin(
  userId: string,
  name: string,
  won: boolean,
  payout: number,
  servedSeconds: number
): CasinoEntry {
  const ledger = loadLedger();
  const e = entryFor(ledger, userId, name);
  e.spins += 1;
  if (won) {
    e.wins += 1;
    e.cred += payout;
    e.streak = e.streak > 0 ? e.streak + 1 : 1;
  } else {
    e.losses += 1;
    e.served += servedSeconds;
    e.streak = e.streak < 0 ? e.streak - 1 : -1;
  }
  saveLedger(ledger);
  return e;
}

/** Record time served by a Wheel of Fate victim (no cred movement — fate pays nothing). */
export function recordWheelVictim(userId: string, name: string, servedSeconds: number): void {
  const ledger = loadLedger();
  const e = entryFor(ledger, userId, name);
  e.served += servedSeconds;
  saveLedger(ledger);
}

/**
 * One-line standings for prompt injection (same precomputed-number rule as the
 * review tally: the LLM reads the book, it does not get to invent the book).
 */
let standingsCache: { at: number; line: string | null } | null = null;
export function getCasinoStandingsLine(): string | null {
  const now = Date.now();
  if (standingsCache && now - standingsCache.at < 60_000) return standingsCache.line;
  let line: string | null = null;
  try {
    const entries = Object.values(loadLedger()).filter((e) => e.spins > 0 || e.served > 0);
    if (entries.length > 0) {
      const rich = [...entries].sort((a, b) => b.cred - a.cred).slice(0, 3);
      const boxed = [...entries].sort((a, b) => b.served - a.served)[0];
      const richLine = rich.map((e) => `${e.name} ${e.cred} cred`).join(', ');
      line =
        `CASINO LEDGER (real, precomputed — quote exactly, never invent numbers): ` +
        `top cred: ${richLine}.` +
        (boxed && boxed.served > 0
          ? ` Most boxed: ${boxed.name} (${boxed.served}s lifetime).`
          : '');
    }
  } catch {
    // no book yet — no standings line
  }
  standingsCache = { at: now, line };
  return line;
}

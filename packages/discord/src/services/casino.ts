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

// ---------------------------------------------------------------------------
// BLACKJACK — real server-side cards. The LLM dealt itself soft hands and let
// everyone win (three dealer busts in a row, "Ace+6+3 is 20"), so the deck
// moved into code: the appended TABLE block is the truth, the patter is vibes.
// One live hand per player per channel; a new [DEAL] voids the old hand.
// ---------------------------------------------------------------------------

interface BjCard {
  label: string;
  v: number;
}
interface BjSession {
  userId: string;
  name: string;
  stake: number;
  player: BjCard[];
  dealer: BjCard[];
  at: number;
}

const BJ_TTL_MS = 15 * 60 * 1000;
const bjTables = new Map<string, BjSession>();

const BJ_RANKS: Array<[string, number]> = [
  ['A', 11], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
  ['8', 8], ['9', 9], ['10', 10], ['J', 10], ['Q', 10], ['K', 10],
];
const BJ_SUITS = ['♠', '♥', '♦', '♣'];

function bjDraw(): BjCard {
  const [r, v] = BJ_RANKS[Math.floor(Math.random() * BJ_RANKS.length)];
  return { label: `${r}${BJ_SUITS[Math.floor(Math.random() * BJ_SUITS.length)]}`, v };
}

export function bjValue(cards: BjCard[]): number {
  let total = cards.reduce((s, c) => s + c.v, 0);
  let aces = cards.filter((c) => c.v === 11).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

export function bjFmt(cards: BjCard[]): string {
  return cards.map((c) => `**${c.label}**`).join(' ');
}

function bjKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function bjSweep(): void {
  const now = Date.now();
  for (const [k, s] of bjTables) if (now - s.at > BJ_TTL_MS) bjTables.delete(k);
}

export interface BjState {
  session: BjSession;
  playerValue: number;
  dealerValue: number;
}

/** Deal a fresh hand. Returns 'natural' when the player has 21 off the deal (auto-resolved). */
export function bjDeal(
  channelId: string,
  userId: string,
  name: string,
  stake: number
): BjState & { natural: boolean; dealerNatural: boolean } {
  bjSweep();
  const session: BjSession = {
    userId,
    name,
    stake,
    player: [bjDraw(), bjDraw()],
    dealer: [bjDraw(), bjDraw()],
    at: Date.now(),
  };
  const playerValue = bjValue(session.player);
  const dealerValue = bjValue(session.dealer);
  const natural = playerValue === 21;
  const dealerNatural = dealerValue === 21;
  if (natural) {
    bjTables.delete(bjKey(channelId, userId)); // resolved on the spot
  } else {
    bjTables.set(bjKey(channelId, userId), session);
  }
  return { session, playerValue, dealerValue, natural, dealerNatural };
}

/** Hit the live hand. Null if there's no hand at this table. Busts resolve the hand. */
export function bjHit(
  channelId: string,
  userId: string
): (BjState & { drawn: BjCard; bust: boolean }) | null {
  bjSweep();
  const session = bjTables.get(bjKey(channelId, userId));
  if (!session) return null;
  const drawn = bjDraw();
  session.player.push(drawn);
  session.at = Date.now();
  const playerValue = bjValue(session.player);
  const bust = playerValue > 21;
  if (bust) bjTables.delete(bjKey(channelId, userId));
  return { session, playerValue, dealerValue: bjValue(session.dealer), drawn, bust };
}

/** Stand: dealer draws to 17+, hand resolves. Null if there's no hand at this table. */
export function bjStand(
  channelId: string,
  userId: string
): (BjState & { outcome: 'win' | 'lose' | 'push' }) | null {
  bjSweep();
  const session = bjTables.get(bjKey(channelId, userId));
  if (!session) return null;
  bjTables.delete(bjKey(channelId, userId));
  while (bjValue(session.dealer) < 17) session.dealer.push(bjDraw());
  const playerValue = bjValue(session.player);
  const dealerValue = bjValue(session.dealer);
  const outcome =
    dealerValue > 21 || playerValue > dealerValue
      ? 'win'
      : playerValue < dealerValue
        ? 'lose'
        : 'push';
  return { session, playerValue, dealerValue, outcome };
}

// ---------------------------------------------------------------------------
// SLOTS — three weighted reels, subway-themed. Trains pay cred; toilets are
// the house's teeth: two flush half the stake, three flush the whole thing.
// ---------------------------------------------------------------------------

const SLOT_SYMBOLS: Array<[string, number]> = [
  ['🚇', 30], ['🛗', 20], ['🎫', 20], ['🐀', 15], ['🚽', 15],
];

function slotReel(): string {
  let roll = Math.random() * 100;
  for (const [sym, weight] of SLOT_SYMBOLS) {
    roll -= weight;
    if (roll <= 0) return sym;
  }
  return SLOT_SYMBOLS[0][0];
}

export interface SlotResult {
  reels: string[];
  credDelta: number;
  boxSeconds: number;
  label: string;
}

export function spinSlots(stake: number): SlotResult {
  const reels = [slotReel(), slotReel(), slotReel()];
  const count = (sym: string) => reels.filter((r) => r === sym).length;
  const trains = count('🚇');
  const toilets = count('🚽');
  if (trains === 3) return { reels, credDelta: stake * 10, boxSeconds: 0, label: 'FULL SERVICE — JACKPOT' };
  if (toilets === 3) return { reels, credDelta: 0, boxSeconds: stake, label: 'THE FLUSH' };
  if (reels[0] === reels[1] && reels[1] === reels[2])
    return { reels, credDelta: stake * 4, boxSeconds: 0, label: 'triple' };
  if (toilets === 2)
    return { reels, credDelta: 0, boxSeconds: Math.max(5, Math.floor(stake / 2)), label: 'half flush' };
  if (trains === 2) return { reels, credDelta: stake, boxSeconds: 0, label: 'two trains' };
  return { reels, credDelta: 0, boxSeconds: 0, label: 'nothing' };
}

/** Cred adjustments from table games (blackjack, slots) — spins/streaks stay roulette-only. */
export function adjustCred(userId: string, name: string, delta: number): CasinoEntry {
  const ledger = loadLedger();
  const e = entryFor(ledger, userId, name);
  e.cred += delta;
  saveLedger(ledger);
  return e;
}

/** Time served at the tables (busts, flushes) — only call when the timeout actually landed. */
export function recordTableServed(userId: string, name: string, seconds: number): CasinoEntry {
  const ledger = loadLedger();
  const e = entryFor(ledger, userId, name);
  e.served += seconds;
  saveLedger(ledger);
  return e;
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

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

// CLOSED by management order (EJ, 2026-07-20). Flip CASINO_OPEN=true to reopen the
// floor — the ledger, the melt state, and the games are all preserved under the tarp.
export const CASINO_OPEN = process.env.CASINO_OPEN === 'true';

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

// ---------------------------------------------------------------------------
// THE MELT — the house slowly loses its mind. Every game played ticks a
// persistent counter (stored under the reserved '__house' key in the ledger
// file); the counter maps to a madness tier; the tier bends the verdict
// blocks from professional croupier → cracks showing → unwell → the fish era.
// The MATH never melts: stakes, rolls, cards, and payouts stay exact and
// legible. Only the house's grip on reality goes.
// ---------------------------------------------------------------------------

interface HouseState {
  events: number;
}

function houseState(ledger: Ledger): HouseState {
  const anyLedger = ledger as unknown as Record<string, unknown>;
  if (!anyLedger.__house) anyLedger.__house = { events: 0 };
  return anyLedger.__house as HouseState;
}

/** Tick the melt forward one game. Call once per game marker handled. */
export function bumpHouseEvents(): number {
  const ledger = loadLedger();
  const house = houseState(ledger);
  house.events += 1;
  saveLedger(ledger);
  return house.events;
}

/** 0 = professional · 1 = cracks showing · 2 = unwell · 3 = the fish era */
export function houseMadness(): number {
  const events = houseState(loadLedger()).events;
  if (events < 25) return 0;
  if (events < 60) return 1;
  if (events < 120) return 2;
  return 3;
}

// Deep cuts harvested from weeks of prison logs. Tier pools escalate: the
// house starts citing the lore, then living in it.
const LORE_T1 = [
  'The wheel would like it noted that it has never been to gloxenville.',
  'This result has been entered in the document. The good half.',
  'Somewhere, a man is tunneling toward a fish. The house respects that.',
  'The house is legally required to disclose that the tutorial is non existant.',
  'The napkin has been updated.',
  'The felt was tested for petplay compliance. It passed. Nobody is sure what the test was.',
];
const LORE_T2 = [
  'The hole card smelled faintly of the Gulf of Riga.',
  'Winnings may be redeemed for one (1) wet tile. There is one wet tile. It is not for sale.',
  'The reels are 40km from the fish and closing.',
  'The napkin has been notarized. The notary was also a napkin.',
  'im bilding it. im bilding it so hard.',
  'A conductor cat crossed the felt mid-hand. Play continued. It always does.',
  'The dealer heard the Cucurella song once and now shuffles to it.',
  'jan_gbg verified the helicopter. The house has no further comment on the helicopter.',
];
const LORE_T3 = [
  'THE HOUSE HAS SEEN THE FISH. THE FISH HAS SEEN THE HOUSE.',
  'Vade retro satana. The dealer whispers it before every shuffle now. We let him.',
  'The wheel eats a paella. The wheel drinks a star.',
  'No viable path was found to your money.',
  'The drills are singing hymns under the felt.',
  'Colin brought his own chair to this table. Security did nothing. Security is also a napkin.',
  'All debts are payable in wet tiles at the current exchange rate (1 tile = the dream).',
  'The pit boss is fifteen transit agencies wearing a trench coat.',
  'A man named Coochiefarter once tipped the house $1000. We built this wing with it. This is the wing.',
];

/**
 * A small italic aside the house mutters under a verdict. Empty string at
 * tier 0; increasingly frequent and unhinged as the melt progresses.
 */
export function houseFlourish(): string {
  const tier = houseMadness();
  if (tier === 0) return '';
  const odds = tier === 1 ? 0.35 : tier === 2 ? 0.6 : 0.9;
  if (Math.random() > odds) return '';
  const pool = tier === 1 ? LORE_T1 : tier === 2 ? [...LORE_T1, ...LORE_T2] : [...LORE_T2, ...LORE_T3];
  return pool[Math.floor(Math.random() * pool.length)];
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
// Once the house is unwell (madness ≥2), the fish surfaces on the reels.
// Kaicardenas2 has been tunneling toward it for weeks; it was inevitable.
const SLOT_SYMBOLS_MELTED: Array<[string, number]> = [...SLOT_SYMBOLS, ['🐟', 6]];

function slotReel(symbols: Array<[string, number]>): string {
  const total = symbols.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [sym, weight] of symbols) {
    roll -= weight;
    if (roll <= 0) return sym;
  }
  return symbols[0][0];
}

export interface SlotResult {
  reels: string[];
  credDelta: number;
  boxSeconds: number;
  label: string;
}

export function spinSlots(stake: number): SlotResult {
  const symbols = houseMadness() >= 2 ? SLOT_SYMBOLS_MELTED : SLOT_SYMBOLS;
  const reels = [slotReel(symbols), slotReel(symbols), slotReel(symbols)];
  const count = (sym: string) => reels.filter((r) => r === sym).length;
  const trains = count('🚇');
  const toilets = count('🚽');
  const fish = count('🐟');
  if (fish === 3)
    return { reels, credDelta: stake * 40, boxSeconds: 0, label: 'THE FISH HAS BEEN REACHED' };
  if (trains === 3) return { reels, credDelta: stake * 10, boxSeconds: 0, label: 'FULL SERVICE — JACKPOT' };
  if (toilets === 3) return { reels, credDelta: 0, boxSeconds: stake, label: 'THE FLUSH' };
  if (reels[0] === reels[1] && reels[1] === reels[2])
    return { reels, credDelta: stake * 4, boxSeconds: 0, label: 'triple' };
  if (fish === 2)
    return { reels, credDelta: stake * 2, boxSeconds: 0, label: 'two fish — the drills sing' };
  if (toilets === 2)
    return { reels, credDelta: 0, boxSeconds: Math.max(5, Math.floor(stake / 2)), label: 'half flush' };
  if (trains === 2) return { reels, credDelta: stake, boxSeconds: 0, label: 'two trains' };
  if (fish === 1)
    return { reels, credDelta: 0, boxSeconds: 0, label: 'one fish — 40km closer' };
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

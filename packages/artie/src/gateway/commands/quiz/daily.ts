/**
 * Async daily quiz — Wordle-style. Same N flashcards for everyone today,
 * each user plays solo on their own time, then opts to share an emoji grid
 * in the channel.
 *
 * - Puzzle is cached in `daily_quiz_puzzles` so every player today gets the
 *   same cards (first player triggers the fetch).
 * - Per-user state lives in `daily_quiz_plays` — UNIQUE(user_id, date, deck)
 *   enforces "one play per day per deck".
 * - Results are stored as a JSON array of 'correct' | 'wrong' so we can render
 *   the emoji grid at any point (in-progress preview or final share card).
 */

import { getSyncDb, logger } from '@coachartie/shared';
import type { FlashcardResponse } from './quiz-session-manager.js';

export const DAILY_QUESTION_COUNT = 5;
const FLASHCARD_API_BASE = 'https://ejfox.com/api/flashcards';
const MAX_FETCH_ATTEMPTS = 15;

export type DailyOutcome = 'correct' | 'wrong';

export interface DailyPuzzle {
  date: string;
  deck: string; // empty string = "all decks"
  cards: FlashcardResponse[];
}

export interface DailyPlay {
  userId: string;
  username: string | null;
  guildId: string | null;
  date: string;
  deck: string;
  currentQuestion: number;
  results: DailyOutcome[];
  guesses: string[];
  completed: boolean;
  shared: boolean;
  startedAt: string;
  completedAt: string | null;
}

let tablesInitialized = false;

export function ensureDailyQuizTables(): void {
  if (tablesInitialized) return;
  const db = getSyncDb();

  // The legacy puzzle table had UNIQUE(date, deck), which blocks per-guild
  // scheduling. If we detect the legacy schema (no guild_id column), rebuild
  // the table — it's only a fetch cache, so dropping it is safe.
  const legacyCols = db.all<{ name: string }>(`PRAGMA table_info(daily_quiz_puzzles)`);
  const hasGuildId = legacyCols.some((c) => c.name === 'guild_id');
  if (legacyCols.length > 0 && !hasGuildId) {
    db.exec(`DROP TABLE daily_quiz_puzzles`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quiz_puzzles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      date TEXT NOT NULL,
      deck TEXT NOT NULL,
      cards_json TEXT NOT NULL,
      scheduled_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Per-guild uniqueness via expression index — NULL guild_id coalesces to ''
  // so the global cache row coexists with per-guild rows for the same date+deck.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_puzzles_scope
       ON daily_quiz_puzzles(COALESCE(guild_id, ''), date, deck)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quiz_guild_config (
      guild_id TEXT PRIMARY KEY,
      allowed_decks TEXT NOT NULL DEFAULT '[]',
      default_deck TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quiz_plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      guild_id TEXT,
      date TEXT NOT NULL,
      deck TEXT NOT NULL,
      current_question INTEGER DEFAULT 0,
      results TEXT NOT NULL DEFAULT '[]',
      guesses TEXT NOT NULL DEFAULT '[]',
      completed INTEGER NOT NULL DEFAULT 0,
      shared INTEGER NOT NULL DEFAULT 0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      UNIQUE(user_id, date, deck)
    )
  `);

  // Migration: add guild_id to existing databases predating server leaderboards.
  const cols = db.all<{ name: string }>(`PRAGMA table_info(daily_quiz_plays)`);
  if (!cols.some((c) => c.name === 'guild_id')) {
    db.exec(`ALTER TABLE daily_quiz_plays ADD COLUMN guild_id TEXT`);
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_daily_quiz_plays_date_deck ON daily_quiz_plays(date, deck)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_daily_quiz_plays_guild_user ON daily_quiz_plays(guild_id, user_id)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quiz_deck_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      target_date TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      winning_deck TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      UNIQUE(guild_id, target_date)
    )
  `);
  db.exec(
    `CREATE TABLE IF NOT EXISTS daily_quiz_deck_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      deck TEXT NOT NULL,
      cast_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id, user_id)
    )`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_daily_quiz_deck_votes_poll ON daily_quiz_deck_votes(poll_id)`
  );

  tablesInitialized = true;
}

/**
 * "Today" in UTC, formatted YYYY-MM-DD. Everyone gets the same puzzle
 * regardless of local time zone — same trade-off as the NYT Wordle.
 */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Fetch up to `count` unique cards from the flashcard API for a deck.
 * Deduped by card id. Used by both the on-demand puzzle creator and the
 * admin scheduler preview.
 */
export async function fetchUniqueCards(
  deck: string,
  count: number = DAILY_QUESTION_COUNT
): Promise<FlashcardResponse[]> {
  const seen = new Set<string>();
  const cards: FlashcardResponse[] = [];
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS && cards.length < count; attempt++) {
    try {
      const url = deck
        ? `${FLASHCARD_API_BASE}/random/${deck}`
        : `${FLASHCARD_API_BASE}/random`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(`Daily puzzle fetch returned ${res.status}`);
        break;
      }
      const card = (await res.json()) as FlashcardResponse;
      if (!seen.has(card.id)) {
        seen.add(card.id);
        cards.push(card);
      }
    } catch (e) {
      logger.warn('Daily puzzle fetch failed:', e);
    }
  }
  return cards;
}

/**
 * Get today's puzzle for a (guild, deck), creating + caching it on first call.
 * Falls back to a shared global puzzle (guild_id IS NULL) when a guild hasn't
 * scheduled its own — keeps the original "one daily for everyone" mode
 * working alongside the per-guild admin scheduler.
 */
export async function getOrCreateDailyPuzzle(
  date: string,
  deck: string,
  guildId: string | null = null
): Promise<DailyPuzzle | null> {
  ensureDailyQuizTables();
  const db = getSyncDb();

  // Prefer a guild-scoped puzzle (admin scheduled or auto-cached), fall back
  // to a global one if this guild hasn't cached anything yet.
  const existing = db.get<{ cards_json: string }>(
    `SELECT cards_json FROM daily_quiz_puzzles
      WHERE date = ? AND deck = ?
        AND (guild_id = ? OR (? IS NULL AND guild_id IS NULL))
      ORDER BY (guild_id IS NULL) ASC
      LIMIT 1`,
    [date, deck, guildId, guildId]
  );
  if (existing) {
    try {
      const cards = JSON.parse(existing.cards_json) as FlashcardResponse[];
      return { date, deck, cards };
    } catch (e) {
      logger.warn('Daily puzzle JSON parse failed; refetching:', e);
    }
  }

  const cards = await fetchUniqueCards(deck, DAILY_QUESTION_COUNT);
  if (cards.length === 0) return null;

  db.run(
    `INSERT OR IGNORE INTO daily_quiz_puzzles (guild_id, date, deck, cards_json) VALUES (?, ?, ?, ?)`,
    [guildId, date, deck, JSON.stringify(cards)]
  );

  // Re-read in case a concurrent insert won the race — keeps everyone on the
  // same cards.
  const row = db.get<{ cards_json: string }>(
    `SELECT cards_json FROM daily_quiz_puzzles
      WHERE date = ? AND deck = ?
        AND (guild_id = ? OR (? IS NULL AND guild_id IS NULL))
      ORDER BY (guild_id IS NULL) ASC
      LIMIT 1`,
    [date, deck, guildId, guildId]
  );
  if (row) {
    return { date, deck, cards: JSON.parse(row.cards_json) as FlashcardResponse[] };
  }
  return { date, deck, cards };
}

/**
 * Pre-create (or replace) tomorrow's puzzle for a specific guild. Used by
 * the admin scheduler. Throws on collision-then-overwrite of an already
 * played-against puzzle? We don't enforce that — admins overwriting an
 * un-played future date is fine, and overwriting today's is allowed too
 * (their call).
 */
export function scheduleDailyPuzzle(
  date: string,
  deck: string,
  guildId: string,
  cards: FlashcardResponse[],
  scheduledBy: string
): void {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const cardsJson = JSON.stringify(cards.slice(0, DAILY_QUESTION_COUNT));
  // INSERT or UPDATE depending on existence — SQLite's UPSERT keeps it
  // atomic against the unique index on (guild_id, date, deck).
  db.run(
    `INSERT INTO daily_quiz_puzzles (guild_id, date, deck, cards_json, scheduled_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(COALESCE(guild_id, ''), date, deck)
     DO UPDATE SET cards_json = excluded.cards_json,
                   scheduled_by = excluded.scheduled_by,
                   created_at = CURRENT_TIMESTAMP`,
    [guildId, date, deck, cardsJson, scheduledBy]
  );
}

/**
 * "Tomorrow" in UTC.
 */
export function tomorrowKey(now: Date = new Date()): string {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function getUserPlay(
  userId: string,
  date: string,
  deck: string
): DailyPlay | null {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const row = db.get<{
    user_id: string;
    username: string | null;
    guild_id: string | null;
    date: string;
    deck: string;
    current_question: number;
    results: string;
    guesses: string;
    completed: number;
    shared: number;
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT user_id, username, guild_id, date, deck, current_question, results, guesses,
            completed, shared, started_at, completed_at
       FROM daily_quiz_plays
      WHERE user_id = ? AND date = ? AND deck = ?`,
    [userId, date, deck]
  );
  if (!row) return null;

  return {
    userId: row.user_id,
    username: row.username,
    guildId: row.guild_id,
    date: row.date,
    deck: row.deck,
    currentQuestion: row.current_question,
    results: safeJsonArray<DailyOutcome>(row.results),
    guesses: safeJsonArray<string>(row.guesses),
    completed: row.completed === 1,
    shared: row.shared === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function startUserPlay(
  userId: string,
  username: string,
  date: string,
  deck: string,
  guildId: string | null = null
): DailyPlay {
  ensureDailyQuizTables();
  const db = getSyncDb();
  db.run(
    `INSERT OR IGNORE INTO daily_quiz_plays
       (user_id, username, guild_id, date, deck, current_question, results, guesses, completed, shared)
       VALUES (?, ?, ?, ?, ?, 0, '[]', '[]', 0, 0)`,
    [userId, username, guildId, date, deck]
  );
  // If the row already existed without a guild_id (older client), patch it
  // so this play counts toward the right server leaderboard.
  if (guildId) {
    db.run(
      `UPDATE daily_quiz_plays
          SET guild_id = COALESCE(guild_id, ?)
        WHERE user_id = ? AND date = ? AND deck = ?`,
      [guildId, userId, date, deck]
    );
  }
  const play = getUserPlay(userId, date, deck);
  if (!play) {
    throw new Error('Failed to start daily quiz play');
  }
  return play;
}

export function recordGuess(
  userId: string,
  date: string,
  deck: string,
  guess: string,
  isCorrect: boolean
): DailyPlay | null {
  const play = getUserPlay(userId, date, deck);
  if (!play || play.completed) return play;

  const results = [...play.results, isCorrect ? 'correct' : 'wrong'] as DailyOutcome[];
  const guesses = [...play.guesses, guess];
  const nextIndex = play.currentQuestion + 1;

  const db = getSyncDb();
  db.run(
    `UPDATE daily_quiz_plays
        SET results = ?, guesses = ?, current_question = ?
      WHERE user_id = ? AND date = ? AND deck = ?`,
    [JSON.stringify(results), JSON.stringify(guesses), nextIndex, userId, date, deck]
  );
  return getUserPlay(userId, date, deck);
}

export function markCompleted(userId: string, date: string, deck: string): DailyPlay | null {
  const db = getSyncDb();
  db.run(
    `UPDATE daily_quiz_plays
        SET completed = 1, completed_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND date = ? AND deck = ?`,
    [userId, date, deck]
  );
  return getUserPlay(userId, date, deck);
}

export function markShared(userId: string, date: string, deck: string): void {
  const db = getSyncDb();
  db.run(
    `UPDATE daily_quiz_plays
        SET shared = 1
      WHERE user_id = ? AND date = ? AND deck = ?`,
    [userId, date, deck]
  );
}

/**
 * Daily leaderboard for one (date, deck) pairing, sorted by score then time.
 */
export interface DailyLeaderboardRow {
  userId: string;
  username: string | null;
  score: number;
  total: number;
  completedAt: string | null;
}

export function getDailyLeaderboard(
  date: string,
  deck: string,
  limit = 10
): DailyLeaderboardRow[] {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const rows = db.all<{
    user_id: string;
    username: string | null;
    results: string;
    completed_at: string | null;
  }>(
    `SELECT user_id, username, results, completed_at
       FROM daily_quiz_plays
      WHERE date = ? AND deck = ? AND completed = 1
      ORDER BY completed_at ASC
      LIMIT ?`,
    [date, deck, limit]
  );

  const leaderboard = rows.map((r) => {
    const results = safeJsonArray<DailyOutcome>(r.results);
    const score = results.filter((o) => o === 'correct').length;
    return {
      userId: r.user_id,
      username: r.username,
      score,
      total: results.length,
      completedAt: r.completed_at,
    };
  });

  leaderboard.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (!a.completedAt) return 1;
    if (!b.completedAt) return -1;
    return a.completedAt.localeCompare(b.completedAt);
  });
  return leaderboard;
}

export type LeaderboardScope = 'today' | 'week' | 'alltime';

export interface ServerLeaderboardRow {
  userId: string;
  username: string | null;
  plays: number; // completed plays in scope
  totalCorrect: number; // sum of correct answers
  perfectDays: number; // plays where score == DAILY_QUESTION_COUNT
  currentStreak: number; // consecutive recent days with a completed play
  bestStreak: number; // longest run of consecutive completed days
}

/**
 * Server-scoped leaderboard. Aggregates every user's completed daily plays
 * inside one guild, returning rankings by total-correct (primary) then
 * perfect-days (tie-break) then plays. Streaks are computed over completed
 * plays regardless of scope so "current streak" survives the daily reset.
 */
export function getServerLeaderboard(
  guildId: string,
  scope: LeaderboardScope = 'alltime',
  limit = 10
): ServerLeaderboardRow[] {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const today = todayKey();

  const where: string[] = ['guild_id = ?', 'completed = 1'];
  const params: (string | number)[] = [guildId];

  if (scope === 'today') {
    where.push('date = ?');
    params.push(today);
  } else if (scope === 'week') {
    // Last 7 calendar days inclusive. ISO date strings sort lexically.
    const weekAgo = new Date(`${today}T00:00:00Z`);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
    where.push('date >= ?');
    params.push(weekAgo.toISOString().slice(0, 10));
  }

  const rows = db.all<{
    user_id: string;
    username: string | null;
    date: string;
    results: string;
  }>(
    `SELECT user_id, username, date, results
       FROM daily_quiz_plays
      WHERE ${where.join(' AND ')}
      ORDER BY user_id, date ASC`,
    params
  );

  // Roll up per user.
  const perUser = new Map<
    string,
    {
      username: string | null;
      plays: number;
      totalCorrect: number;
      perfectDays: number;
      dates: string[];
    }
  >();
  for (const row of rows) {
    const results = safeJsonArray<DailyOutcome>(row.results);
    const score = results.filter((o) => o === 'correct').length;
    const bucket =
      perUser.get(row.user_id) ??
      { username: row.username, plays: 0, totalCorrect: 0, perfectDays: 0, dates: [] };
    bucket.plays += 1;
    bucket.totalCorrect += score;
    if (score === DAILY_QUESTION_COUNT) bucket.perfectDays += 1;
    if (row.username) bucket.username = row.username;
    bucket.dates.push(row.date);
    perUser.set(row.user_id, bucket);
  }

  const out: ServerLeaderboardRow[] = [];
  for (const [userId, bucket] of perUser) {
    const { currentStreak, bestStreak } = computeDayStreaks(bucket.dates, today);
    out.push({
      userId,
      username: bucket.username,
      plays: bucket.plays,
      totalCorrect: bucket.totalCorrect,
      perfectDays: bucket.perfectDays,
      currentStreak,
      bestStreak,
    });
  }

  out.sort((a, b) => {
    if (b.totalCorrect !== a.totalCorrect) return b.totalCorrect - a.totalCorrect;
    if (b.perfectDays !== a.perfectDays) return b.perfectDays - a.perfectDays;
    if (b.plays !== a.plays) return b.plays - a.plays;
    return b.currentStreak - a.currentStreak;
  });

  return out.slice(0, limit);
}

/**
 * Given an ascending list of ISO dates a user completed the daily and
 * "today" as the reference point, return their current and best streaks
 * (consecutive calendar days, allowing today OR yesterday as the leading
 * edge — Wordle-style "you haven't lost the streak yet").
 */
export function computeDayStreaks(
  dates: string[],
  today: string
): { currentStreak: number; bestStreak: number } {
  if (dates.length === 0) return { currentStreak: 0, bestStreak: 0 };
  const unique = [...new Set(dates)].sort();

  let bestStreak = 1;
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    if (consecutive(unique[i - 1], unique[i])) {
      run += 1;
      if (run > bestStreak) bestStreak = run;
    } else {
      run = 1;
    }
  }

  // Current streak: walk backwards from today; allow yesterday as the most
  // recent date (today's daily may not have been played yet).
  const last = unique[unique.length - 1];
  let currentStreak = 0;
  if (last === today || consecutive(last, today)) {
    currentStreak = 1;
    for (let i = unique.length - 2; i >= 0; i--) {
      if (consecutive(unique[i], unique[i + 1])) {
        currentStreak += 1;
      } else {
        break;
      }
    }
  }

  return { currentStreak, bestStreak };
}

function consecutive(a: string, b: string): boolean {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  return db.getTime() - da.getTime() === 24 * 60 * 60 * 1000;
}

/**
 * Render the Wordle-style emoji grid for a results array, padding remaining
 * slots with ⬜ so the row is always DAILY_QUESTION_COUNT wide.
 */
export function renderEmojiGrid(results: DailyOutcome[], total: number): string {
  const cells: string[] = [];
  for (let i = 0; i < total; i++) {
    if (i < results.length) {
      cells.push(results[i] === 'correct' ? '🟩' : '🟥');
    } else {
      cells.push('⬜');
    }
  }
  return cells.join(' ');
}

/**
 * The canonical deck list. The flashcard API exposes more, but these are the
 * ones we surface in slash-command choices. `''` means "all decks (random)".
 */
export const KNOWN_DECKS = [
  '',
  'COMPUTERS',
  'ELECTRICAL_AND_RADIO',
  'POLITICS',
  'RUBIKS_2x2',
  'SAR_AND_WILDERNESS',
] as const;

export interface GuildQuizConfig {
  guildId: string;
  allowedDecks: string[]; // empty array = all known decks allowed
  defaultDeck: string | null;
}

export function getGuildConfig(guildId: string): GuildQuizConfig {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const row = db.get<{ guild_id: string; allowed_decks: string; default_deck: string | null }>(
    `SELECT guild_id, allowed_decks, default_deck FROM daily_quiz_guild_config WHERE guild_id = ?`,
    [guildId]
  );
  if (!row) {
    return { guildId, allowedDecks: [], defaultDeck: null };
  }
  return {
    guildId: row.guild_id,
    allowedDecks: safeJsonArray<string>(row.allowed_decks),
    defaultDeck: row.default_deck,
  };
}

export function setGuildAllowedDecks(guildId: string, decks: string[]): GuildQuizConfig {
  ensureDailyQuizTables();
  const db = getSyncDb();
  // De-dupe + normalize (treat null/undefined as 'all' sentinel)
  const normalized = [...new Set(decks)].filter((d) => KNOWN_DECKS.includes(d as any));
  db.run(
    `INSERT INTO daily_quiz_guild_config (guild_id, allowed_decks, default_deck)
       VALUES (?, ?, NULL)
       ON CONFLICT(guild_id) DO UPDATE SET
         allowed_decks = excluded.allowed_decks,
         updated_at = CURRENT_TIMESTAMP`,
    [guildId, JSON.stringify(normalized)]
  );
  return getGuildConfig(guildId);
}

export function setGuildDefaultDeck(guildId: string, deck: string | null): GuildQuizConfig {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const normalized = deck && KNOWN_DECKS.includes(deck as any) ? deck : null;
  db.run(
    `INSERT INTO daily_quiz_guild_config (guild_id, allowed_decks, default_deck)
       VALUES (?, '[]', ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         default_deck = excluded.default_deck,
         updated_at = CURRENT_TIMESTAMP`,
    [guildId, normalized]
  );
  return getGuildConfig(guildId);
}

/**
 * Is this deck allowed in this guild? An empty allowed list (or no config row)
 * means "no restriction — anything goes" so the feature defaults to open.
 */
export function isDeckAllowedForGuild(guildId: string | null, deck: string): boolean {
  if (!guildId) return true;
  const config = getGuildConfig(guildId);
  if (config.allowedDecks.length === 0) return true;
  return config.allowedDecks.includes(deck);
}

// ---------------------------------------------------------------------------
// Deck votes: group-decided deck for tomorrow's daily puzzle.
// ---------------------------------------------------------------------------

export type PollStatus = 'open' | 'closed';

export interface DeckPoll {
  id: number;
  guildId: string;
  targetDate: string;
  channelId: string | null;
  messageId: string | null;
  status: PollStatus;
  winningDeck: string | null;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface DeckTally {
  deck: string;
  votes: number;
}

function rowToPoll(row: any): DeckPoll {
  return {
    id: row.id,
    guildId: row.guild_id,
    targetDate: row.target_date,
    channelId: row.channel_id,
    messageId: row.message_id,
    status: row.status,
    winningDeck: row.winning_deck,
    createdBy: row.created_by,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

/**
 * Open a deck poll for (guildId, targetDate) if none exists yet. Returns
 * the poll either way.
 */
export function getOrCreateDeckPoll(
  guildId: string,
  targetDate: string,
  createdBy: string
): DeckPoll {
  ensureDailyQuizTables();
  const db = getSyncDb();
  db.run(
    `INSERT OR IGNORE INTO daily_quiz_deck_polls
       (guild_id, target_date, status, created_by)
       VALUES (?, ?, 'open', ?)`,
    [guildId, targetDate, createdBy]
  );
  const row = db.get<any>(
    `SELECT * FROM daily_quiz_deck_polls WHERE guild_id = ? AND target_date = ?`,
    [guildId, targetDate]
  );
  if (!row) throw new Error('Failed to create deck poll');
  return rowToPoll(row);
}

export function getDeckPoll(guildId: string, targetDate: string): DeckPoll | null {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const row = db.get<any>(
    `SELECT * FROM daily_quiz_deck_polls WHERE guild_id = ? AND target_date = ?`,
    [guildId, targetDate]
  );
  return row ? rowToPoll(row) : null;
}

export function getDeckPollById(pollId: number): DeckPoll | null {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const row = db.get<any>(`SELECT * FROM daily_quiz_deck_polls WHERE id = ?`, [pollId]);
  return row ? rowToPoll(row) : null;
}

/**
 * Record where the public poll embed lives so we can refresh it from
 * button handlers without keeping a per-poll in-memory reference.
 */
export function attachPollMessage(pollId: number, channelId: string, messageId: string): void {
  const db = getSyncDb();
  db.run(
    `UPDATE daily_quiz_deck_polls SET channel_id = ?, message_id = ? WHERE id = ?`,
    [channelId, messageId, pollId]
  );
}

/**
 * Cast (or change) a user's vote in an open poll. No-op if the poll is closed.
 */
export function castDeckVote(pollId: number, userId: string, deck: string): void {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const poll = getDeckPollById(pollId);
  if (!poll || poll.status !== 'open') return;
  db.run(
    `INSERT INTO daily_quiz_deck_votes (poll_id, user_id, deck)
       VALUES (?, ?, ?)
       ON CONFLICT(poll_id, user_id) DO UPDATE SET deck = excluded.deck, cast_at = CURRENT_TIMESTAMP`,
    [pollId, userId, deck]
  );
}

/**
 * Tallies for a poll, preserving the order of `choices`. Decks with no votes
 * still appear (zeroed) so the embed bars line up.
 */
export function getDeckVoteTallies(pollId: number, choices: string[]): DeckTally[] {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const rows = db.all<{ deck: string; votes: number }>(
    `SELECT deck, COUNT(*) AS votes
       FROM daily_quiz_deck_votes
      WHERE poll_id = ?
      GROUP BY deck`,
    [pollId]
  );
  const map = new Map(rows.map((r) => [r.deck, r.votes]));
  return choices.map((d) => ({ deck: d, votes: map.get(d) ?? 0 }));
}

/**
 * Pick the winner from a tally array. Highest vote count wins; ties break by
 * the order the deck appears in `choices` (deterministic, matches the
 * button order so the leftmost option wins ties).
 */
export function pickWinningDeck(tallies: DeckTally[]): string | null {
  const max = Math.max(0, ...tallies.map((t) => t.votes));
  if (max === 0) return null;
  return tallies.find((t) => t.votes === max)?.deck ?? null;
}

export interface CloseDeckPollResult {
  winningDeck: string | null;
  tallies: DeckTally[];
}

/**
 * Close a poll and stamp the winning deck. Does NOT fetch cards / schedule
 * — that's the caller's job (so it can pass the result through fetchUniqueCards
 * + scheduleDailyPuzzle).
 */
export function closeDeckPoll(pollId: number, choices: string[]): CloseDeckPollResult {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const tallies = getDeckVoteTallies(pollId, choices);
  const winner = pickWinningDeck(tallies);
  db.run(
    `UPDATE daily_quiz_deck_polls
        SET status = 'closed',
            winning_deck = ?,
            closed_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [winner, pollId]
  );
  return { winningDeck: winner, tallies };
}

// ---------------------------------------------------------------------------
// Per-user stats + achievements (growth: profile cards, social-proof badges).
// ---------------------------------------------------------------------------

export interface UserStats {
  userId: string;
  guildId: string | null;
  totalPlays: number;
  totalCorrect: number;
  perfectDays: number;
  currentStreak: number;
  bestStreak: number;
  recentResults: { date: string; score: number; total: number }[]; // newest first
}

/**
 * Compute aggregate stats for one user, scoped to a guild (or globally when
 * guildId is null). All numbers come from completed plays only.
 */
export function computeUserStats(userId: string, guildId: string | null): UserStats {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const where = guildId ? 'user_id = ? AND guild_id = ? AND completed = 1' : 'user_id = ? AND completed = 1';
  const params = guildId ? [userId, guildId] : [userId];

  const rows = db.all<{ date: string; results: string }>(
    `SELECT date, results FROM daily_quiz_plays
       WHERE ${where}
       ORDER BY date ASC`,
    params
  );

  let totalCorrect = 0;
  let perfectDays = 0;
  const dates: string[] = [];
  for (const row of rows) {
    const r = safeJsonArray<DailyOutcome>(row.results);
    const score = r.filter((o) => o === 'correct').length;
    totalCorrect += score;
    if (score === DAILY_QUESTION_COUNT) perfectDays += 1;
    dates.push(row.date);
  }

  const { currentStreak, bestStreak } = computeDayStreaks(dates, todayKey());

  // Newest-first recent results (capped at 7 — enough for the profile grid).
  const recentRows = [...rows].reverse().slice(0, 7);
  const recentResults = recentRows.map((row) => {
    const r = safeJsonArray<DailyOutcome>(row.results);
    return { date: row.date, score: r.filter((o) => o === 'correct').length, total: r.length };
  });

  return {
    userId,
    guildId,
    totalPlays: rows.length,
    totalCorrect,
    perfectDays,
    currentStreak,
    bestStreak,
    recentResults,
  };
}

/**
 * Look up a user's most recent completed play (any deck) — used by the
 * /quiz challenge callout so we can flex their score at the target.
 */
export function getMostRecentCompletedPlay(
  userId: string,
  guildId: string | null,
  onOrAfter?: string
): DailyPlay | null {
  ensureDailyQuizTables();
  const db = getSyncDb();
  const conditions: string[] = ['user_id = ?', 'completed = 1'];
  const params: (string | number)[] = [userId];
  if (guildId) {
    conditions.push('guild_id = ?');
    params.push(guildId);
  }
  if (onOrAfter) {
    conditions.push('date >= ?');
    params.push(onOrAfter);
  }
  const row = db.get<any>(
    `SELECT user_id, username, guild_id, date, deck, current_question, results, guesses,
            completed, shared, started_at, completed_at
       FROM daily_quiz_plays
      WHERE ${conditions.join(' AND ')}
      ORDER BY date DESC, completed_at DESC
      LIMIT 1`,
    params
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    guildId: row.guild_id,
    date: row.date,
    deck: row.deck,
    currentQuestion: row.current_question,
    results: safeJsonArray<DailyOutcome>(row.results),
    guesses: safeJsonArray<string>(row.guesses),
    completed: row.completed === 1,
    shared: row.shared === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface Achievement {
  id: string;
  emoji: string;
  label: string;
  description: string;
  test: (stats: UserStats) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_blood',
    emoji: '🎯',
    label: 'First Blood',
    description: 'Completed your first daily quiz',
    test: (s) => s.totalPlays >= 1,
  },
  {
    id: 'perfect_1',
    emoji: '⭐',
    label: 'Perfect',
    description: `Score ${DAILY_QUESTION_COUNT}/${DAILY_QUESTION_COUNT} on a daily`,
    test: (s) => s.perfectDays >= 1,
  },
  {
    id: 'streak_3',
    emoji: '🔥',
    label: 'On Fire',
    description: '3-day streak',
    test: (s) => s.bestStreak >= 3,
  },
  {
    id: 'streak_7',
    emoji: '💎',
    label: 'Week Warrior',
    description: '7-day streak',
    test: (s) => s.bestStreak >= 7,
  },
  {
    id: 'streak_30',
    emoji: '👑',
    label: 'Habitual',
    description: '30-day streak',
    test: (s) => s.bestStreak >= 30,
  },
  {
    id: 'perfect_10',
    emoji: '🌟',
    label: 'Stellar',
    description: '10 perfect days',
    test: (s) => s.perfectDays >= 10,
  },
  {
    id: 'points_25',
    emoji: '🏅',
    label: 'Quarter Century',
    description: '25 lifetime points',
    test: (s) => s.totalCorrect >= 25,
  },
  {
    id: 'points_100',
    emoji: '🏆',
    label: 'Centurion',
    description: '100 lifetime points',
    test: (s) => s.totalCorrect >= 100,
  },
];

export function computeAchievements(stats: UserStats): Set<string> {
  return new Set(ACHIEVEMENTS.filter((a) => a.test(stats)).map((a) => a.id));
}

/**
 * Achievements newly unlocked between two stat snapshots. Used for the
 * "just unlocked" celebratory post that drops in channel after a user
 * finishes their daily.
 */
export function diffAchievements(before: UserStats, after: UserStats): Achievement[] {
  const beforeSet = computeAchievements(before);
  const afterSet = computeAchievements(after);
  return ACHIEVEMENTS.filter((a) => !beforeSet.has(a.id) && afterSet.has(a.id));
}

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

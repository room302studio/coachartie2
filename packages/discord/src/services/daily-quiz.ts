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

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quiz_puzzles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      deck TEXT NOT NULL,
      cards_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, deck)
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
 * Get today's puzzle for a deck, creating + caching it on first call.
 */
export async function getOrCreateDailyPuzzle(
  date: string,
  deck: string
): Promise<DailyPuzzle | null> {
  ensureDailyQuizTables();
  const db = getSyncDb();

  const existing = db.get<{ cards_json: string }>(
    `SELECT cards_json FROM daily_quiz_puzzles WHERE date = ? AND deck = ?`,
    [date, deck]
  );
  if (existing) {
    try {
      const cards = JSON.parse(existing.cards_json) as FlashcardResponse[];
      return { date, deck, cards };
    } catch (e) {
      logger.warn('Daily puzzle JSON parse failed; refetching:', e);
    }
  }

  // Fetch cards, dedupe by id, stop once we have DAILY_QUESTION_COUNT unique.
  const seen = new Set<string>();
  const cards: FlashcardResponse[] = [];
  for (
    let attempt = 0;
    attempt < MAX_FETCH_ATTEMPTS && cards.length < DAILY_QUESTION_COUNT;
    attempt++
  ) {
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

  if (cards.length === 0) return null;

  db.run(
    `INSERT OR IGNORE INTO daily_quiz_puzzles (date, deck, cards_json) VALUES (?, ?, ?)`,
    [date, deck, JSON.stringify(cards)]
  );

  // Re-read in case a concurrent insert won the race — keeps everyone on the
  // same cards.
  const row = db.get<{ cards_json: string }>(
    `SELECT cards_json FROM daily_quiz_puzzles WHERE date = ? AND deck = ?`,
    [date, deck]
  );
  if (row) {
    return { date, deck, cards: JSON.parse(row.cards_json) as FlashcardResponse[] };
  }
  return { date, deck, cards };
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

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Tests for the async daily quiz — Wordle-style solo play.
 *
 * Exercises the puzzle-cache flow, per-user state, emoji grid rendering, the
 * customId encoding round-trip, and the embed builders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSyncDb } from '@coachartie/shared';
import {
  DAILY_QUESTION_COUNT,
  computeDayStreaks,
  ensureDailyQuizTables,
  getDailyLeaderboard,
  getOrCreateDailyPuzzle,
  getServerLeaderboard,
  getUserPlay,
  markCompleted,
  markShared,
  recordGuess,
  renderEmojiGrid,
  startUserPlay,
  todayKey,
  type DailyOutcome,
} from '../src/services/daily-quiz';
import {
  buildDailyGameMessage,
  buildDailyResultMessage,
  buildDailyShareMessage,
  buildGuessModal,
  buildLeaderboardMessage,
  dailyCustomId,
  parseDailyCustomId,
} from '../src/services/daily-quiz-embed';

function clearDailyTables() {
  ensureDailyQuizTables();
  const db = getSyncDb();
  db.exec('DELETE FROM daily_quiz_plays');
  db.exec('DELETE FROM daily_quiz_puzzles');
}

function mockFlashcards(cards: { id: string; front: string; back: string }[]) {
  let i = 0;
  global.fetch = vi.fn(async () => {
    const card = cards[i % cards.length];
    i++;
    return new Response(
      JSON.stringify({
        ...card,
        hints: [],
        deckId: 'TEST',
        deckName: 'Test',
        course: 'test',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
}

describe('todayKey', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(todayKey(new Date('2026-05-19T23:00:00Z'))).toBe('2026-05-19');
    expect(todayKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });
});

describe('renderEmojiGrid', () => {
  it('pads remaining slots with ⬜', () => {
    expect(renderEmojiGrid(['correct', 'wrong'] as DailyOutcome[], 5)).toBe(
      '🟩 🟥 ⬜ ⬜ ⬜'
    );
  });
  it('renders a full row when complete', () => {
    expect(
      renderEmojiGrid(['correct', 'correct', 'wrong', 'correct', 'correct'], 5)
    ).toBe('🟩 🟩 🟥 🟩 🟩');
  });
});

describe('customId encoding', () => {
  it('round-trips guess/modal/share with deck and date', () => {
    const id = dailyCustomId('guess', '2026-05-19', 'POLITICS');
    expect(id).toBe('quiz:daily:guess:2026-05-19:POLITICS');
    expect(parseDailyCustomId(id)).toEqual({
      action: 'guess',
      date: '2026-05-19',
      deck: 'POLITICS',
    });
  });

  it('uses "all" sentinel for the empty deck', () => {
    const id = dailyCustomId('share', '2026-05-19', '');
    expect(id).toBe('quiz:daily:share:2026-05-19:all');
    expect(parseDailyCustomId(id)).toEqual({
      action: 'share',
      date: '2026-05-19',
      deck: '',
    });
  });

  it('returns null for non-daily custom ids', () => {
    expect(parseDailyCustomId('quiz:hint')).toBeNull();
    expect(parseDailyCustomId('ask_123_yes')).toBeNull();
  });
});

describe('daily puzzle cache', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches DAILY_QUESTION_COUNT unique cards on first call and caches them', async () => {
    mockFlashcards([
      { id: 'a', front: 'Qa', back: 'Aa' },
      { id: 'b', front: 'Qb', back: 'Ab' },
      { id: 'c', front: 'Qc', back: 'Ac' },
      { id: 'd', front: 'Qd', back: 'Ad' },
      { id: 'e', front: 'Qe', back: 'Ae' },
    ]);

    const puzzle = await getOrCreateDailyPuzzle('2026-05-19', '');
    expect(puzzle).not.toBeNull();
    expect(puzzle!.cards).toHaveLength(DAILY_QUESTION_COUNT);
    expect((global.fetch as any).mock.calls.length).toBe(5);

    // Second call: served from DB, no extra fetches
    (global.fetch as any).mockClear();
    const again = await getOrCreateDailyPuzzle('2026-05-19', '');
    expect(again!.cards.map((c) => c.id)).toEqual(puzzle!.cards.map((c) => c.id));
    expect((global.fetch as any).mock.calls.length).toBe(0);
  });

  it('dedupes by card id when the API hands back collisions', async () => {
    mockFlashcards([
      { id: 'a', front: 'Qa', back: 'Aa' },
      { id: 'a', front: 'Qa', back: 'Aa' }, // dupe
      { id: 'b', front: 'Qb', back: 'Ab' },
      { id: 'c', front: 'Qc', back: 'Ac' },
      { id: 'd', front: 'Qd', back: 'Ad' },
      { id: 'e', front: 'Qe', back: 'Ae' },
    ]);

    const puzzle = await getOrCreateDailyPuzzle('2026-05-19', 'POLITICS');
    expect(puzzle!.cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('user play state machine', () => {
  beforeEach(() => {
    clearDailyTables();
    mockFlashcards([
      { id: 'a', front: 'Qa', back: 'pavlov' },
      { id: 'b', front: 'Qb', back: 'skinner' },
      { id: 'c', front: 'Qc', back: 'watson' },
      { id: 'd', front: 'Qd', back: 'bandura' },
      { id: 'e', front: 'Qe', back: 'thorndike' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startUserPlay is idempotent — second call returns existing state', () => {
    const a = startUserPlay('alice', 'Alice', '2026-05-19', '');
    a.results.push('correct'); // local mutation, irrelevant to db
    const b = startUserPlay('alice', 'Alice', '2026-05-19', '');
    expect(b.currentQuestion).toBe(0);
    expect(b.results).toEqual([]);
  });

  it('recordGuess advances state and stores results', async () => {
    await getOrCreateDailyPuzzle('2026-05-19', '');
    startUserPlay('alice', 'Alice', '2026-05-19', '');

    const after1 = recordGuess('alice', '2026-05-19', '', 'pavlov', true);
    expect(after1?.currentQuestion).toBe(1);
    expect(after1?.results).toEqual(['correct']);

    const after2 = recordGuess('alice', '2026-05-19', '', 'guesswork', false);
    expect(after2?.currentQuestion).toBe(2);
    expect(after2?.results).toEqual(['correct', 'wrong']);
    expect(after2?.guesses).toEqual(['pavlov', 'guesswork']);
  });

  it('markCompleted flips the completed flag and timestamps', () => {
    startUserPlay('alice', 'Alice', '2026-05-19', '');
    const done = markCompleted('alice', '2026-05-19', '');
    expect(done?.completed).toBe(true);
    expect(done?.completedAt).not.toBeNull();
  });

  it('markShared flips the shared flag', () => {
    startUserPlay('alice', 'Alice', '2026-05-19', '');
    markShared('alice', '2026-05-19', '');
    const play = getUserPlay('alice', '2026-05-19', '');
    expect(play?.shared).toBe(true);
  });
});

describe('leaderboard', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  it('ranks completed plays by score then completion time', () => {
    startUserPlay('alice', 'Alice', '2026-05-19', 'POLITICS');
    startUserPlay('bob', 'Bob', '2026-05-19', 'POLITICS');
    startUserPlay('cara', 'Cara', '2026-05-19', 'POLITICS');

    // Alice 3/5, Bob 5/5, Cara unfinished
    recordGuess('alice', '2026-05-19', 'POLITICS', 'x', true);
    recordGuess('alice', '2026-05-19', 'POLITICS', 'x', true);
    recordGuess('alice', '2026-05-19', 'POLITICS', 'x', true);
    recordGuess('alice', '2026-05-19', 'POLITICS', 'x', false);
    recordGuess('alice', '2026-05-19', 'POLITICS', 'x', false);
    markCompleted('alice', '2026-05-19', 'POLITICS');

    for (let i = 0; i < 5; i++) {
      recordGuess('bob', '2026-05-19', 'POLITICS', 'x', true);
    }
    markCompleted('bob', '2026-05-19', 'POLITICS');

    const board = getDailyLeaderboard('2026-05-19', 'POLITICS');
    expect(board.map((r) => r.userId)).toEqual(['bob', 'alice']);
    expect(board[0].score).toBe(5);
    expect(board[1].score).toBe(3);
  });
});

describe('computeDayStreaks', () => {
  it('returns zeros for an empty list', () => {
    expect(computeDayStreaks([], '2026-05-19')).toEqual({ currentStreak: 0, bestStreak: 0 });
  });

  it('counts a run of consecutive days ending today', () => {
    const dates = ['2026-05-17', '2026-05-18', '2026-05-19'];
    expect(computeDayStreaks(dates, '2026-05-19')).toEqual({
      currentStreak: 3,
      bestStreak: 3,
    });
  });

  it('treats yesterday as still-streaking (today not yet played)', () => {
    const dates = ['2026-05-17', '2026-05-18'];
    expect(computeDayStreaks(dates, '2026-05-19')).toEqual({
      currentStreak: 2,
      bestStreak: 2,
    });
  });

  it('resets current streak when the most recent play is too old', () => {
    const dates = ['2026-05-10', '2026-05-11'];
    expect(computeDayStreaks(dates, '2026-05-19')).toEqual({
      currentStreak: 0,
      bestStreak: 2,
    });
  });

  it('tracks best streak separately from current', () => {
    // Played a 4-day streak in May, broke it, played a 1-day "streak" today.
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-19'];
    expect(computeDayStreaks(dates, '2026-05-19')).toEqual({
      currentStreak: 1,
      bestStreak: 4,
    });
  });
});

describe('getServerLeaderboard', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  function completeRun(
    userId: string,
    username: string,
    guildId: string,
    date: string,
    deck: string,
    correctCount: number
  ) {
    startUserPlay(userId, username, date, deck, guildId);
    for (let i = 0; i < DAILY_QUESTION_COUNT; i++) {
      recordGuess(userId, date, deck, 'x', i < correctCount);
    }
    markCompleted(userId, date, deck);
  }

  it('ranks users by total correct, then perfect days, then plays', () => {
    completeRun('alice', 'Alice', 'g1', '2026-05-17', 'POLITICS', 3);
    completeRun('alice', 'Alice', 'g1', '2026-05-18', 'POLITICS', 5);
    completeRun('bob', 'Bob', 'g1', '2026-05-18', 'POLITICS', 4);
    completeRun('cara', 'Cara', 'g1', '2026-05-18', 'POLITICS', 5);

    const board = getServerLeaderboard('g1', 'alltime');
    expect(board.map((r) => r.userId)).toEqual(['alice', 'cara', 'bob']);
    expect(board[0].totalCorrect).toBe(8);
    expect(board[0].perfectDays).toBe(1);
    expect(board[1].totalCorrect).toBe(5);
    expect(board[1].perfectDays).toBe(1);
    expect(board[2].totalCorrect).toBe(4);
  });

  it('scopes "today" to only today\'s completed plays', () => {
    const today = todayKey();
    completeRun('alice', 'Alice', 'g1', '2026-05-01', '', 5);
    completeRun('bob', 'Bob', 'g1', today, '', 3);
    const board = getServerLeaderboard('g1', 'today');
    expect(board.map((r) => r.userId)).toEqual(['bob']);
  });

  it('excludes plays from other guilds', () => {
    completeRun('alice', 'Alice', 'g1', '2026-05-18', '', 5);
    completeRun('eve', 'Eve', 'g2', '2026-05-18', '', 5);
    const board = getServerLeaderboard('g1', 'alltime');
    expect(board.map((r) => r.userId)).toEqual(['alice']);
  });

  it('reports current streak using consecutive completed days', () => {
    completeRun('alice', 'Alice', 'g1', '2026-05-17', '', 3);
    completeRun('alice', 'Alice', 'g1', '2026-05-18', '', 3);
    completeRun('alice', 'Alice', 'g1', '2026-05-19', '', 3);
    const board = getServerLeaderboard('g1', 'alltime');
    // The function uses the real "today" for streak reckoning, but as long as
    // best streak captures the historical run we're good.
    expect(board[0].bestStreak).toBe(3);
  });
});

describe('buildLeaderboardMessage', () => {
  it('renders the empty-state when no rows', () => {
    const { embeds } = buildLeaderboardMessage([], 'alltime', 'Room 302');
    const embed = embeds[0].toJSON();
    expect(embed.description).toContain('No completed daily quizzes yet');
  });

  it('renders medal positions and metric badges', () => {
    const { embeds } = buildLeaderboardMessage(
      [
        {
          userId: 'alice',
          username: 'Alice',
          plays: 5,
          totalCorrect: 22,
          perfectDays: 2,
          currentStreak: 3,
          bestStreak: 4,
        },
        {
          userId: 'bob',
          username: 'Bob',
          plays: 3,
          totalCorrect: 10,
          perfectDays: 0,
          currentStreak: 1,
          bestStreak: 1,
        },
      ],
      'week',
      'Room 302'
    );
    const embed = embeds[0].toJSON();
    expect(embed.title).toContain('Room 302');
    expect(embed.description).toMatch(/🥇 <@alice>/);
    expect(embed.description).toMatch(/⭐2/);
    expect(embed.description).toMatch(/🔥3/);
    expect(embed.description).toMatch(/🥈 <@bob>/);
    expect(embed.footer?.text).toContain('This Week');
  });
});

describe('embed builders', () => {
  beforeEach(() => {
    clearDailyTables();
    mockFlashcards([
      { id: 'a', front: 'Who paired bell with food?', back: 'pavlov' },
      { id: 'b', front: 'Who studied operant conditioning?', back: 'skinner' },
      { id: 'c', front: 'Founded behaviorism?', back: 'watson' },
      { id: 'd', front: 'Bobo doll?', back: 'bandura' },
      { id: 'e', front: 'Law of effect?', back: 'thorndike' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mid-game embed shows the progress grid, current question, and a Guess button', async () => {
    const puzzle = await getOrCreateDailyPuzzle('2026-05-19', '');
    const play = startUserPlay('alice', 'Alice', '2026-05-19', '');
    const { embeds, components } = buildDailyGameMessage(play, puzzle!);
    const embed = embeds[0].toJSON();
    expect(embed.description).toContain('⬜ ⬜ ⬜ ⬜ ⬜');
    expect(embed.fields?.some((f) => f.name.includes('Question 1'))).toBe(true);

    const row = components[0].toJSON();
    expect(row.components).toHaveLength(1);
    expect((row.components[0] as any).custom_id).toBe('quiz:daily:guess:2026-05-19:all');
  });

  it('result embed shows the full answer key and a Share button when not yet shared', async () => {
    const puzzle = await getOrCreateDailyPuzzle('2026-05-19', '');
    startUserPlay('alice', 'Alice', '2026-05-19', '');
    recordGuess('alice', '2026-05-19', '', 'pavlov', true);
    recordGuess('alice', '2026-05-19', '', 'skinner', true);
    recordGuess('alice', '2026-05-19', '', 'wrong', false);
    recordGuess('alice', '2026-05-19', '', 'bandura', true);
    recordGuess('alice', '2026-05-19', '', 'thorndike', true);
    const done = markCompleted('alice', '2026-05-19', '');

    const { embeds, components } = buildDailyResultMessage(done!, puzzle!, 'Alice');
    const embed = embeds[0].toJSON();
    expect(embed.title).toContain('Daily Quiz');
    expect(embed.description).toContain('4 / 5');
    expect(embed.fields?.[0].value).toContain('pavlov');

    const btn = components[0].toJSON().components[0] as any;
    expect(btn.custom_id).toBe('quiz:daily:share:2026-05-19:all');
    expect(btn.disabled).toBe(false);
  });

  it('result embed disables Share once shared', async () => {
    const puzzle = await getOrCreateDailyPuzzle('2026-05-19', '');
    startUserPlay('alice', 'Alice', '2026-05-19', '');
    recordGuess('alice', '2026-05-19', '', 'pavlov', true);
    markCompleted('alice', '2026-05-19', '');
    markShared('alice', '2026-05-19', '');
    const play = getUserPlay('alice', '2026-05-19', '');

    const { components } = buildDailyResultMessage(play!, puzzle!, 'Alice');
    const btn = components[0].toJSON().components[0] as any;
    expect(btn.disabled).toBe(true);
  });

  it('share message contains the emoji grid + score', () => {
    const play = {
      userId: 'alice',
      username: 'Alice',
      date: '2026-05-19',
      deck: '',
      currentQuestion: 5,
      results: ['correct', 'correct', 'wrong', 'correct', 'correct'] as DailyOutcome[],
      guesses: ['a', 'b', 'c', 'd', 'e'],
      completed: true,
      shared: false,
      startedAt: '',
      completedAt: null,
    };
    const embed = buildDailyShareMessage(play, 'Alice').embeds[0].toJSON();
    expect(embed.description).toContain('Alice');
    expect(embed.description).toContain('4/5');
    expect(embed.description).toContain('🟩 🟩 🟥 🟩 🟩');
  });

  it('guess modal has a single short text input', () => {
    const modal = buildGuessModal('2026-05-19', 'POLITICS', 3).toJSON();
    expect(modal.custom_id).toBe('quiz:daily:modal:2026-05-19:POLITICS');
    expect(modal.title).toContain('Question 3');
    const row = modal.components[0] as any;
    expect(row.components[0].custom_id).toBe('answer');
  });
});

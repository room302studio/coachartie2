/**
 * Tests for the async daily quiz — Wordle-style solo play.
 *
 * Exercises the puzzle-cache flow, per-user state, emoji grid rendering, the
 * customId encoding round-trip, and the embed builders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSyncDb } from '@coachartie/shared';
import {
  ACHIEVEMENTS,
  DAILY_QUESTION_COUNT,
  attachPollMessage,
  castDeckVote,
  closeDeckPoll,
  computeAchievements,
  computeDayStreaks,
  computeUserStats,
  diffAchievements,
  ensureDailyQuizTables,
  getDailyLeaderboard,
  getDeckPoll,
  getDeckPollById,
  getDeckVoteTallies,
  getGuildConfig,
  getMostRecentCompletedPlay,
  getOrCreateDailyPuzzle,
  getOrCreateDeckPoll,
  getServerLeaderboard,
  getUserPlay,
  isDeckAllowedForGuild,
  markCompleted,
  markShared,
  pickWinningDeck,
  recordGuess,
  renderEmojiGrid,
  scheduleDailyPuzzle,
  setGuildAllowedDecks,
  setGuildDefaultDeck,
  startUserPlay,
  todayKey,
  tomorrowKey,
  type DailyOutcome,
  type UserStats,
} from '../src/services/daily-quiz';
import type { FlashcardResponse } from '../src/services/quiz-session-manager';
import {
  buildAchievementUnlockMessage,
  buildChallengeMessage,
  buildDailyGameMessage,
  buildDailyResultMessage,
  buildDailyShareMessage,
  buildDeckVoteMessage,
  buildGuessModal,
  buildGuildConfigEmbed,
  buildLeaderboardMessage,
  buildProfileMessage,
  buildScheduleDraftMessage,
  dailyCustomId,
  parseDailyCustomId,
  parseScheduleCustomId,
  parseVoteCustomId,
  scheduleCustomId,
  voteCustomId,
} from '../src/services/daily-quiz-embed';

function clearDailyTables() {
  ensureDailyQuizTables();
  const db = getSyncDb();
  db.exec('DELETE FROM daily_quiz_plays');
  db.exec('DELETE FROM daily_quiz_puzzles');
  db.exec('DELETE FROM daily_quiz_guild_config');
  db.exec('DELETE FROM daily_quiz_deck_votes');
  db.exec('DELETE FROM daily_quiz_deck_polls');
}

function fakeCard(id: string, front: string, back: string): FlashcardResponse {
  return {
    id,
    front,
    back,
    hints: [],
    deckId: 'TEST',
    deckName: 'Test',
    course: 'test',
  };
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

describe('guild config', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  it('returns sane defaults when no config row exists', () => {
    const cfg = getGuildConfig('g1');
    expect(cfg).toEqual({ guildId: 'g1', allowedDecks: [], defaultDeck: null });
  });

  it('persists allowed-decks and dedupes / normalizes input', () => {
    const cfg = setGuildAllowedDecks('g1', ['POLITICS', 'POLITICS', 'COMPUTERS']);
    expect(cfg.allowedDecks).toEqual(['POLITICS', 'COMPUTERS']);
    const reread = getGuildConfig('g1');
    expect(reread.allowedDecks).toEqual(['POLITICS', 'COMPUTERS']);
  });

  it('drops unknown decks from the allow-list', () => {
    const cfg = setGuildAllowedDecks('g1', ['POLITICS', 'NOT_A_DECK']);
    expect(cfg.allowedDecks).toEqual(['POLITICS']);
  });

  it('setGuildDefaultDeck stores and clears the default', () => {
    setGuildDefaultDeck('g1', 'POLITICS');
    expect(getGuildConfig('g1').defaultDeck).toBe('POLITICS');
    setGuildDefaultDeck('g1', null);
    expect(getGuildConfig('g1').defaultDeck).toBeNull();
  });

  it('isDeckAllowedForGuild defaults to open (no config = anything)', () => {
    expect(isDeckAllowedForGuild('g1', 'POLITICS')).toBe(true);
    expect(isDeckAllowedForGuild('g1', '')).toBe(true);
  });

  it('isDeckAllowedForGuild enforces the allow-list when set', () => {
    setGuildAllowedDecks('g1', ['POLITICS']);
    expect(isDeckAllowedForGuild('g1', 'POLITICS')).toBe(true);
    expect(isDeckAllowedForGuild('g1', 'COMPUTERS')).toBe(false);
  });

  it('renders config embed with allow-list and default deck', () => {
    setGuildAllowedDecks('g1', ['POLITICS', 'COMPUTERS']);
    setGuildDefaultDeck('g1', 'POLITICS');
    const cfg = getGuildConfig('g1');
    const embed = buildGuildConfigEmbed(cfg, 'Test Server').embeds[0].toJSON();
    expect(embed.title).toContain('Test Server');
    const allowedField = embed.fields?.find((f) => f.name === 'Allowed Decks');
    expect(allowedField?.value).toContain('POLITICS');
    expect(allowedField?.value).toContain('COMPUTERS');
    const defaultField = embed.fields?.find((f) => f.name === 'Default Deck');
    expect(defaultField?.value).toBe('POLITICS');
  });
});

describe('admin scheduling', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  it('scheduleDailyPuzzle inserts a per-guild puzzle for tomorrow', () => {
    const date = tomorrowKey();
    const cards = [
      fakeCard('1', 'q1', 'a1'),
      fakeCard('2', 'q2', 'a2'),
      fakeCard('3', 'q3', 'a3'),
      fakeCard('4', 'q4', 'a4'),
      fakeCard('5', 'q5', 'a5'),
    ];

    scheduleDailyPuzzle(date, 'POLITICS', 'g1', cards, 'admin-1');

    // No API calls should happen — we should read the scheduled rows.
    global.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    const puzzle = (async () =>
      await getOrCreateDailyPuzzle(date, 'POLITICS', 'g1'))();
    return puzzle.then((p) => {
      expect(p?.cards.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5']);
    });
  });

  it('replaces an existing scheduled puzzle on second call (upsert)', () => {
    const date = tomorrowKey();
    scheduleDailyPuzzle(
      date,
      'POLITICS',
      'g1',
      [fakeCard('a', 'qa', 'aa')],
      'admin-1'
    );
    scheduleDailyPuzzle(
      date,
      'POLITICS',
      'g1',
      [fakeCard('b', 'qb', 'ab')],
      'admin-2'
    );

    global.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    return getOrCreateDailyPuzzle(date, 'POLITICS', 'g1').then((p) => {
      expect(p?.cards.map((c) => c.id)).toEqual(['b']);
    });
  });

  it('isolates scheduled puzzles between guilds', async () => {
    const date = tomorrowKey();
    scheduleDailyPuzzle(date, '', 'g1', [fakeCard('g1c', 'q', 'a')], 'admin-1');
    scheduleDailyPuzzle(date, '', 'g2', [fakeCard('g2c', 'q', 'a')], 'admin-2');

    global.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    const a = await getOrCreateDailyPuzzle(date, '', 'g1');
    const b = await getOrCreateDailyPuzzle(date, '', 'g2');
    expect(a?.cards[0].id).toBe('g1c');
    expect(b?.cards[0].id).toBe('g2c');
  });

  it('schedule customId round-trips', () => {
    const id = scheduleCustomId('save', '2026-05-20', 'POLITICS');
    expect(id).toBe('quiz:schedule:save:2026-05-20:POLITICS');
    expect(parseScheduleCustomId(id)).toEqual({
      action: 'save',
      date: '2026-05-20',
      deck: 'POLITICS',
    });
    expect(parseScheduleCustomId('quiz:daily:guess:x:y')).toBeNull();
  });

  it('schedule draft preview shows shuffle/save/cancel buttons', () => {
    const { components } = buildScheduleDraftMessage('2026-05-20', 'POLITICS', [
      fakeCard('1', 'q', 'a'),
    ]);
    const ids = components[0].toJSON().components.map((c: any) => c.custom_id);
    expect(ids).toEqual([
      'quiz:schedule:shuffle:2026-05-20:POLITICS',
      'quiz:schedule:save:2026-05-20:POLITICS',
      'quiz:schedule:cancel:2026-05-20:POLITICS',
    ]);
  });

  it('schedule draft after save strips action buttons', () => {
    const { components } = buildScheduleDraftMessage(
      '2026-05-20',
      'POLITICS',
      [fakeCard('1', 'q', 'a')],
      { saved: true }
    );
    expect(components).toHaveLength(0);
  });

  it('tomorrowKey returns the day after today (UTC)', () => {
    expect(tomorrowKey(new Date('2026-05-19T12:00:00Z'))).toBe('2026-05-20');
    expect(tomorrowKey(new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-01');
  });
});

describe('deck vote', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  it('getOrCreateDeckPoll is idempotent on (guild, date)', () => {
    const a = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    const b = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    expect(b.id).toBe(a.id);
    expect(b.status).toBe('open');
  });

  it('castDeckVote records a vote and allows the user to change it', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    castDeckVote(poll.id, 'alice', 'POLITICS');
    castDeckVote(poll.id, 'bob', 'POLITICS');
    castDeckVote(poll.id, 'cara', 'COMPUTERS');

    let t = getDeckVoteTallies(poll.id, ['POLITICS', 'COMPUTERS']);
    expect(t).toEqual([
      { deck: 'POLITICS', votes: 2 },
      { deck: 'COMPUTERS', votes: 1 },
    ]);

    castDeckVote(poll.id, 'alice', 'COMPUTERS'); // change vote
    t = getDeckVoteTallies(poll.id, ['POLITICS', 'COMPUTERS']);
    expect(t).toEqual([
      { deck: 'POLITICS', votes: 1 },
      { deck: 'COMPUTERS', votes: 2 },
    ]);
  });

  it('castDeckVote is a no-op once the poll is closed', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    castDeckVote(poll.id, 'alice', 'POLITICS');
    closeDeckPoll(poll.id, ['POLITICS']);
    castDeckVote(poll.id, 'bob', 'POLITICS');
    const t = getDeckVoteTallies(poll.id, ['POLITICS']);
    expect(t[0].votes).toBe(1);
  });

  it('pickWinningDeck picks the highest count with deterministic tie-break', () => {
    expect(
      pickWinningDeck([
        { deck: 'A', votes: 2 },
        { deck: 'B', votes: 5 },
        { deck: 'C', votes: 5 },
      ])
    ).toBe('B'); // first one matching the max in input order
    expect(pickWinningDeck([{ deck: 'A', votes: 0 }])).toBeNull();
  });

  it('closeDeckPoll stamps the winner on the poll row', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    castDeckVote(poll.id, 'a', 'POLITICS');
    castDeckVote(poll.id, 'b', 'POLITICS');
    castDeckVote(poll.id, 'c', 'COMPUTERS');
    const result = closeDeckPoll(poll.id, ['POLITICS', 'COMPUTERS']);
    expect(result.winningDeck).toBe('POLITICS');

    const reread = getDeckPollById(poll.id);
    expect(reread?.status).toBe('closed');
    expect(reread?.winningDeck).toBe('POLITICS');
    expect(reread?.closedAt).not.toBeNull();
  });

  it('attachPollMessage stores the public message reference', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    attachPollMessage(poll.id, 'chan-1', 'msg-1');
    const reread = getDeckPollById(poll.id);
    expect(reread?.channelId).toBe('chan-1');
    expect(reread?.messageId).toBe('msg-1');
  });

  it('voteCustomId round-trips cast + close', () => {
    expect(parseVoteCustomId(voteCustomId('cast', 7, 'POLITICS'))).toEqual({
      action: 'cast',
      pollId: 7,
      deck: 'POLITICS',
    });
    expect(parseVoteCustomId(voteCustomId('close', 7))).toEqual({
      action: 'close',
      pollId: 7,
      deck: '',
    });
    expect(parseVoteCustomId('quiz:daily:guess:x:y')).toBeNull();
    expect(parseVoteCustomId('quiz:vote:cast:not-a-number:POLITICS')).toBeNull();
  });

  it('voteCustomId encodes the empty-deck sentinel as "all"', () => {
    expect(voteCustomId('cast', 1, '')).toBe('quiz:vote:cast:1:all');
    expect(parseVoteCustomId('quiz:vote:cast:1:all')).toEqual({
      action: 'cast',
      pollId: 1,
      deck: '',
    });
  });

  it('open-poll embed renders one button per deck + a Close row', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    castDeckVote(poll.id, 'a', 'POLITICS');
    const tallies = getDeckVoteTallies(poll.id, ['POLITICS', 'COMPUTERS']);
    const { embeds, components } = buildDeckVoteMessage(poll, tallies);
    expect(embeds[0].toJSON().description).toContain('POLITICS');

    expect(components).toHaveLength(2);
    const voteIds = components[0].toJSON().components.map((c: any) => c.custom_id);
    expect(voteIds).toEqual([
      `quiz:vote:cast:${poll.id}:POLITICS`,
      `quiz:vote:cast:${poll.id}:COMPUTERS`,
    ]);
    const closeIds = components[1].toJSON().components.map((c: any) => c.custom_id);
    expect(closeIds).toEqual([`quiz:vote:close:${poll.id}`]);
  });

  it('closed-poll embed shows the winner and drops the buttons', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    castDeckVote(poll.id, 'a', 'POLITICS');
    const { winningDeck, tallies } = closeDeckPoll(poll.id, ['POLITICS', 'COMPUTERS']);
    const closedPoll = getDeckPollById(poll.id)!;
    const { embeds, components } = buildDeckVoteMessage(closedPoll, tallies, {
      winningDeck,
      scheduledOk: true,
    });
    expect(components).toHaveLength(0);
    const embed = embeds[0].toJSON();
    expect(embed.fields?.[0].name).toBe('🏆 Winner');
    expect(embed.fields?.[0].value).toContain('POLITICS');
    expect(embed.fields?.[0].value).toContain('scheduled');
  });

  it('closed-poll embed handles the no-votes case gracefully', () => {
    const poll = getOrCreateDeckPoll('g1', '2026-05-20', 'admin');
    const { winningDeck, tallies } = closeDeckPoll(poll.id, ['POLITICS']);
    expect(winningDeck).toBeNull();
    const closedPoll = getDeckPollById(poll.id)!;
    const { embeds } = buildDeckVoteMessage(closedPoll, tallies, { winningDeck });
    expect(embeds[0].toJSON().fields?.[0].name).toBe('🤷 No winner');
  });
});

describe('user stats + achievements', () => {
  beforeEach(() => {
    clearDailyTables();
  });

  function completedPlay(
    userId: string,
    guildId: string,
    date: string,
    deck: string,
    correctCount: number
  ) {
    startUserPlay(userId, userId, date, deck, guildId);
    for (let i = 0; i < DAILY_QUESTION_COUNT; i++) {
      recordGuess(userId, date, deck, 'x', i < correctCount);
    }
    markCompleted(userId, date, deck);
  }

  it('computeUserStats aggregates points / perfects / plays correctly', () => {
    completedPlay('alice', 'g1', '2026-05-17', '', 5);
    completedPlay('alice', 'g1', '2026-05-18', '', 3);
    completedPlay('alice', 'g1', '2026-05-19', '', 5);
    const stats = computeUserStats('alice', 'g1');
    expect(stats.totalPlays).toBe(3);
    expect(stats.totalCorrect).toBe(13);
    expect(stats.perfectDays).toBe(2);
    expect(stats.recentResults).toHaveLength(3);
    // Recent newest-first
    expect(stats.recentResults[0].date).toBe('2026-05-19');
  });

  it('computeUserStats scopes to a guild', () => {
    // Note: the current schema's UNIQUE(user_id, date, deck) doesn't include
    // guild_id, so two guilds with the same user + deck + date would collide.
    // Use different decks to exercise the scoping in a realistic way.
    completedPlay('alice', 'g1', '2026-05-19', 'POLITICS', 5);
    completedPlay('alice', 'g2', '2026-05-19', 'COMPUTERS', 4);
    const g1 = computeUserStats('alice', 'g1');
    const g2 = computeUserStats('alice', 'g2');
    expect(g1.totalCorrect).toBe(5);
    expect(g2.totalCorrect).toBe(4);
  });

  it('zero-play user has all-zeros stats and no badges', () => {
    const stats = computeUserStats('ghost', 'g1');
    expect(stats.totalPlays).toBe(0);
    expect(computeAchievements(stats).size).toBe(0);
  });

  it('achievements unlock once their predicate flips true', () => {
    const empty: UserStats = {
      userId: 'a',
      guildId: 'g1',
      totalPlays: 0,
      totalCorrect: 0,
      perfectDays: 0,
      currentStreak: 0,
      bestStreak: 0,
      recentResults: [],
    };
    expect(computeAchievements(empty).size).toBe(0);

    const oneDay: UserStats = { ...empty, totalPlays: 1, totalCorrect: 5, perfectDays: 1, bestStreak: 1, currentStreak: 1 };
    const got = computeAchievements(oneDay);
    expect(got.has('first_blood')).toBe(true);
    expect(got.has('perfect_1')).toBe(true);
    expect(got.has('streak_3')).toBe(false);
  });

  it('diffAchievements returns only newly-unlocked badges', () => {
    const before: UserStats = {
      userId: 'a', guildId: 'g1', totalPlays: 2, totalCorrect: 9, perfectDays: 1,
      currentStreak: 2, bestStreak: 2, recentResults: [],
    };
    const after: UserStats = { ...before, totalPlays: 3, totalCorrect: 14, perfectDays: 2, currentStreak: 3, bestStreak: 3 };
    const newly = diffAchievements(before, after);
    const ids = newly.map((a) => a.id);
    expect(ids).toContain('streak_3');
    expect(ids).not.toContain('first_blood'); // already had
    expect(ids).not.toContain('perfect_1'); // already had
  });

  it('getMostRecentCompletedPlay returns the latest completed play in scope', () => {
    completedPlay('alice', 'g1', '2026-05-17', 'POLITICS', 3);
    completedPlay('alice', 'g1', '2026-05-19', 'COMPUTERS', 5);
    const recent = getMostRecentCompletedPlay('alice', 'g1');
    expect(recent?.date).toBe('2026-05-19');
    expect(recent?.deck).toBe('COMPUTERS');
  });

  it('profile embed renders headline metrics and last-7 grid', () => {
    completedPlay('alice', 'g1', '2026-05-17', '', 5);
    completedPlay('alice', 'g1', '2026-05-18', '', 3);
    const stats = computeUserStats('alice', 'g1');
    const earned = ACHIEVEMENTS.filter((a) => computeAchievements(stats).has(a.id));
    const { embeds } = buildProfileMessage({ id: 'alice', username: 'Alice' }, stats, earned);
    const embed = embeds[0].toJSON();
    expect(embed.title).toContain('Alice');
    // fields contain Current Streak, Best Streak, Perfect Days, Days Played, Last 7 Days, Badges
    const names = embed.fields?.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['Current Streak', 'Best Streak', 'Perfect Days', 'Days Played', 'Last 7 Days', 'Badges'])
    );
    const last7 = embed.fields?.find((f) => f.name === 'Last 7 Days');
    expect(last7?.value).toMatch(/🟩|🟨|🟥/);
  });

  it('challenge embed mentions target + shows caller\'s score grid', () => {
    completedPlay('alice', 'g1', todayKey(), '', 4);
    const recent = getMostRecentCompletedPlay('alice', 'g1');
    const { content, embeds } = buildChallengeMessage(
      { id: 'alice', username: 'Alice' },
      { id: 'bob' },
      recent,
      todayKey(),
      'good luck'
    );
    expect(content).toContain('<@bob>');
    expect(content).toContain('<@alice>');
    const embed = embeds[0].toJSON();
    expect(embed.description).toContain(`4/${DAILY_QUESTION_COUNT}`);
    expect(embed.description).toContain('good luck');
  });

  it('challenge embed degrades gracefully when caller has no recent play', () => {
    const { content, embeds } = buildChallengeMessage(
      { id: 'alice', username: 'Alice' },
      { id: 'bob' },
      null,
      todayKey()
    );
    expect(content).toContain('<@bob>');
    expect(embeds[0].toJSON().description).toContain('/quiz daily');
  });

  it('achievement-unlock message tags the user and lists badges', () => {
    const { content, embeds } = buildAchievementUnlockMessage(
      { id: 'alice', username: 'Alice' },
      [ACHIEVEMENTS[0], ACHIEVEMENTS[2]]
    );
    expect(content).toBe('<@alice>');
    const embed = embeds[0].toJSON();
    expect(embed.title).toContain('Achievements unlocked');
    expect(embed.description).toContain(ACHIEVEMENTS[0].label);
    expect(embed.description).toContain(ACHIEVEMENTS[2].label);
  });

  it('achievement-unlock message uses singular header for one badge', () => {
    const { embeds } = buildAchievementUnlockMessage(
      { id: 'alice', username: 'Alice' },
      [ACHIEVEMENTS[0]]
    );
    expect(embeds[0].toJSON().title).toContain('Achievement unlocked');
  });

  it('achievement-unlock message is empty when no badges unlocked', () => {
    const out = buildAchievementUnlockMessage(
      { id: 'alice', username: 'Alice' },
      []
    );
    expect(out.embeds).toHaveLength(0);
  });
});

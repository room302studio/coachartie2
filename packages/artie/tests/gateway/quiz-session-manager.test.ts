/**
 * Tests for quiz session manager — streak tracking and AI-judged answers.
 *
 * The flashcard fetch is mocked so these tests run offline. The LLM judge is
 * gated on OPENROUTER_API_KEY; when unset, verifyAnswerWithLLM returns null
 * and the manager treats AI-judged checks as misses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  quizSessionManager,
  looksLikeAnswerAttempt,
  type FlashcardResponse,
} from '../src/services/quiz-session-manager';

const CHANNEL = 'test-channel-streaks';

function makeCard(front: string, back: string, id = '1'): FlashcardResponse {
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

describe('looksLikeAnswerAttempt', () => {
  it('rejects empty / whitespace', () => {
    expect(looksLikeAnswerAttempt('')).toBe(false);
    expect(looksLikeAnswerAttempt('   ')).toBe(false);
  });

  it('rejects slash and bang commands', () => {
    expect(looksLikeAnswerAttempt('/quiz stop')).toBe(false);
    expect(looksLikeAnswerAttempt('!skip')).toBe(false);
  });

  it('rejects pure emoji / punctuation', () => {
    expect(looksLikeAnswerAttempt('🔥🔥')).toBe(false);
    expect(looksLikeAnswerAttempt('!!!')).toBe(false);
  });

  it('rejects very long messages', () => {
    expect(looksLikeAnswerAttempt('a'.repeat(201))).toBe(false);
  });

  it('accepts plausible short answers', () => {
    expect(looksLikeAnswerAttempt('classical conditioning')).toBe(true);
    expect(looksLikeAnswerAttempt('Pavlov')).toBe(true);
  });
});

describe('quizSessionManager streaks', () => {
  beforeEach(() => {
    // Mock the flashcard API so we control the cards
    let n = 0;
    global.fetch = vi.fn(async () => {
      n++;
      return new Response(JSON.stringify(makeCard(`Q${n}`, `A${n}`, String(n))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    quizSessionManager.endQuiz(CHANNEL);
    vi.restoreAllMocks();
  });

  it('starts at streak 0 and bumps to 1 on correct answer', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
    });

    const result = quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A1');
    expect(result).not.toBeNull();
    expect(result).not.toBe('maybe');
    if (!result || result === 'maybe') return;
    expect(result.correct).toBe(true);
    expect(result.winnerStreak).toBe(1);
    expect(result.currentStreaks.get('alice')).toBe(1);
    expect(result.bestStreaks.get('alice')).toBe(1);
  });

  it('builds a streak across consecutive correct answers', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
    });

    const r1 = quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A1');
    expect(r1 && r1 !== 'maybe' && r1.winnerStreak).toBe(1);
    await quizSessionManager.nextQuestion(CHANNEL);

    const r2 = quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A2');
    expect(r2 && r2 !== 'maybe' && r2.winnerStreak).toBe(2);
    expect(r2 && r2 !== 'maybe' && r2.bestStreaks.get('alice')).toBe(2);
  });

  it("breaks a user's streak when someone else wins a question they attempted", async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
    });

    // Alice wins Q1
    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A1');
    await quizSessionManager.nextQuestion(CHANNEL);

    // Alice attempts Q2 with a wrong answer; Bob wins it
    const aliceMiss = quizSessionManager.checkAnswer(CHANNEL, 'alice', 'wrong-guess');
    expect(aliceMiss).toBeNull();
    quizSessionManager.recordAttempt(CHANNEL, 'alice');

    const bobWin = quizSessionManager.checkAnswer(CHANNEL, 'bob', 'A2');
    expect(bobWin && bobWin !== 'maybe' && bobWin.winnerStreak).toBe(1);
    expect(bobWin && bobWin !== 'maybe' && bobWin.currentStreaks.get('alice')).toBe(0);
    // But Alice's best in the session is still her earlier 1
    expect(bobWin && bobWin !== 'maybe' && bobWin.bestStreaks.get('alice')).toBe(1);
  });

  it('does not break the streak of a user who did not attempt', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
    });

    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A1');
    await quizSessionManager.nextQuestion(CHANNEL);

    // Alice doesn't attempt Q2 at all; Bob wins
    const bobWin = quizSessionManager.checkAnswer(CHANNEL, 'bob', 'A2');
    expect(bobWin && bobWin !== 'maybe' && bobWin.currentStreaks.get('alice')).toBe(1);
  });

  it('resets streaks for all attempters on timeout', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
    });

    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A1');
    await quizSessionManager.nextQuestion(CHANNEL);

    // Alice & Bob both miss Q2
    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'nope');
    quizSessionManager.recordAttempt(CHANNEL, 'alice');
    quizSessionManager.recordAttempt(CHANNEL, 'bob');

    await quizSessionManager.handleTimeout(CHANNEL);

    const session = quizSessionManager.getSession(CHANNEL);
    expect(session?.streaks.get('alice')).toBe(0);
    expect(session?.streaks.get('bob')).toBe(0);
    // Alice's best streak from earlier survives
    expect(session?.bestStreaks.get('alice')).toBe(1);
  });

  it('returns "maybe" when AI judge is on, string match fails, message looks like an attempt', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
      aiJudge: true,
    });

    const result = quizSessionManager.checkAnswer(CHANNEL, 'alice', 'completely different');
    expect(result).toBe('maybe');
  });

  it('returns null for chatter when AI judge is on', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
      aiJudge: true,
    });

    expect(quizSessionManager.checkAnswer(CHANNEL, 'alice', '!skip')).toBeNull();
    expect(quizSessionManager.checkAnswer(CHANNEL, 'alice', '🔥')).toBeNull();
  });

  it('drops AI verdicts that arrive after the question is already answered', async () => {
    await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'starter',
      questionCount: 3,
      aiJudge: true,
    });

    // Force the LLM to say yes, but also have someone else win first
    process.env.OPENROUTER_API_KEY = 'fake-test-key';
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'yes' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    // Bob wins synchronously
    const bobWin = quizSessionManager.checkAnswer(CHANNEL, 'bob', 'A1');
    expect(bobWin && bobWin !== 'maybe').toBeTruthy();

    // Alice's deferred LLM check should now be a no-op
    const aliceLate = await quizSessionManager.checkAnswerWithAI(
      CHANNEL,
      'alice',
      'something fuzzy'
    );
    expect(aliceLate).toBeNull();
    delete process.env.OPENROUTER_API_KEY;
  });
});

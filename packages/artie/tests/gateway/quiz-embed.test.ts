/**
 * Tests for the Wordle-style quiz embed/button builders and the supporting
 * state (progress bar, hint reveal, message-id tracking).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  quizSessionManager,
  renderProgressBar,
  buildInitialProgress,
  type FlashcardResponse,
} from '../src/services/quiz-session-manager';
import {
  buildLiveQuizMessage,
  buildQuizSummary,
  quizButtonId,
  parseQuizButtonId,
} from '../src/services/quiz-embed';

const CHANNEL = 'test-channel-embed';

function makeCard(front: string, back: string, hints: string[] = [], id = '1'): FlashcardResponse {
  return {
    id,
    front,
    back,
    hints,
    deckId: 'TEST',
    deckName: 'Test',
    course: 'test',
  };
}

describe('progress bar', () => {
  it('buildInitialProgress marks the first slot current, rest upcoming', () => {
    const p = buildInitialProgress(3);
    expect(p).toEqual(['current', 'upcoming', 'upcoming']);
  });

  it('renderProgressBar maps outcomes to emoji squares', () => {
    expect(renderProgressBar(['correct', 'missed', 'current', 'upcoming'])).toBe(
      '🟩 ⬛ 🟨 ⬜'
    );
  });
});

describe('quizButtonId / parseQuizButtonId', () => {
  it('round-trips known actions', () => {
    for (const action of ['hint', 'skip', 'end', 'again'] as const) {
      expect(parseQuizButtonId(quizButtonId(action))).toBe(action);
    }
  });

  it('returns null for non-quiz custom ids', () => {
    expect(parseQuizButtonId('ask_123_yes')).toBeNull();
    expect(parseQuizButtonId('quiz:bogus')).toBeNull();
  });
});

describe('live quiz embed', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify(makeCard('Define classical conditioning', 'pavlov', ['Russian scientist'])),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    quizSessionManager.endQuiz(CHANNEL);
    vi.restoreAllMocks();
  });

  it('renders the current question, progress bar, and an action row with 3 buttons', async () => {
    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 3,
    });

    const { embeds, components } = buildLiveQuizMessage(session);
    expect(embeds).toHaveLength(1);
    const embed = embeds[0].toJSON();
    expect(embed.title).toContain('Quiz');
    expect(embed.description).toContain('🟨'); // current marker
    expect(embed.fields?.some((f) => f.name.includes('Question'))).toBe(true);
    expect(embed.fields?.some((f) => f.name.includes('Scoreboard'))).toBe(true);

    expect(components).toHaveLength(1);
    const row = components[0].toJSON();
    expect(row.components).toHaveLength(3);
    const ids = row.components.map((c: any) => c.custom_id);
    expect(ids).toEqual(['quiz:hint', 'quiz:skip', 'quiz:end']);
  });

  it('disables the Hint button when no hints remain', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(makeCard('No hints?', 'nope', [])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 1,
    });

    const row = buildLiveQuizMessage(session).components[0].toJSON();
    const hintBtn = row.components.find((c: any) => c.custom_id === 'quiz:hint') as any;
    expect(hintBtn.disabled).toBe(true);
  });

  it('revealHint appends a hint and decrements the remaining counter', async () => {
    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 1,
    });

    const before = buildLiveQuizMessage(session);
    const hintBtnBefore = before.components[0].toJSON().components.find(
      (c: any) => c.custom_id === 'quiz:hint'
    ) as any;
    expect(hintBtnBefore.label).toBe('Hint (1)');

    const hint = quizSessionManager.revealHint(CHANNEL);
    expect(hint).toBe('Russian scientist');

    const after = buildLiveQuizMessage(session);
    const embed = after.embeds[0].toJSON();
    expect(embed.fields?.some((f) => f.name.startsWith('💡 Hints'))).toBe(true);

    const hintBtnAfter = after.components[0].toJSON().components.find(
      (c: any) => c.custom_id === 'quiz:hint'
    ) as any;
    // No more hints — button disabled, count gone from label
    expect(hintBtnAfter.disabled).toBe(true);
    expect(hintBtnAfter.label).toBe('Hint');
  });

  it('progress bar advances after correct + nextQuestion', async () => {
    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 3,
    });

    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'pavlov');
    expect(session.progress).toEqual(['correct', 'upcoming', 'upcoming']);

    await quizSessionManager.nextQuestion(CHANNEL);
    expect(session.progress).toEqual(['correct', 'current', 'upcoming']);
  });
});

describe('quiz summary card', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(makeCard('Q', 'A')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    quizSessionManager.endQuiz(CHANNEL);
    vi.restoreAllMocks();
  });

  it('shows winner, streak champion, and a Play Again button', async () => {
    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 2,
    });

    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A');
    await quizSessionManager.nextQuestion(CHANNEL);
    quizSessionManager.checkAnswer(CHANNEL, 'alice', 'A');

    const summary = buildQuizSummary(session, new Map([['alice', 2]]));
    const embed = summary.embeds[0].toJSON();
    expect(embed.title).toContain('Complete');
    expect(embed.description).toContain('🟩');
    expect(embed.description).toContain('<@alice>'); // winner mention
    expect(embed.description).toContain('Streak Champion');

    const row = summary.components[0].toJSON();
    expect(row.components).toHaveLength(1);
    expect((row.components[0] as any).custom_id).toBe('quiz:again');
  });

  it('handles the "nobody scored" case gracefully', async () => {
    const session = await quizSessionManager.startQuiz({
      channelId: CHANNEL,
      userId: 'host',
      questionCount: 1,
    });

    const summary = buildQuizSummary(session, new Map());
    const embed = summary.embeds[0].toJSON();
    expect(embed.description).toContain('No one scored');
  });
});

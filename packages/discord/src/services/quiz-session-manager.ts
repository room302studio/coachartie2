import { logger } from '@coachartie/shared';

const FLASHCARD_API_BASE = 'https://ejfox.com/api/flashcards';
const DEFAULT_QUESTION_COUNT = 10;
const QUESTION_TIMEOUT_MS = 30000; // 30 seconds per question
const AI_JUDGE_MODEL = process.env.QUIZ_JUDGE_MODEL || 'google/gemini-2.0-flash-001';
const AI_JUDGE_URL =
  process.env.QUIZ_JUDGE_URL || 'https://router.tools.ejfox.com/v1/chat/completions';

export interface FlashcardResponse {
  id: string;
  front: string;
  back: string;
  hints: string[];
  deckId: string;
  deckName: string;
  course: string;
}

export interface QuizSession {
  channelId: string;
  deckId?: string;
  currentCard: FlashcardResponse | null;
  questionNumber: number;
  totalQuestions: number;
  scores: Map<string, number>; // userId -> score
  streaks: Map<string, number>; // userId -> current streak in this session
  bestStreaks: Map<string, number>; // userId -> best streak in this session
  answered: boolean;
  aiJudge: boolean; // Use LLM to grade fuzzy answers
  startedBy: string;
  startedAt: Date;
  questionTimeout?: ReturnType<typeof setTimeout>;
  onTimeout?: () => void; // Callback when question times out
  // userIds who attempted this question (used to break streaks on miss)
  attemptedThisQuestion: Set<string>;
  // In-flight LLM judgements so we don't fire duplicate calls per user/question
  pendingJudgements: Set<string>;
}

export interface QuizStartOptions {
  channelId: string;
  userId: string;
  deckId?: string;
  questionCount?: number;
  aiJudge?: boolean;
  onTimeout?: (session: QuizSession) => void;
}

export interface AnswerResult {
  correct: boolean;
  isFirstCorrect: boolean;
  correctAnswer: string;
  currentScores: Map<string, number>;
  currentStreaks: Map<string, number>;
  bestStreaks: Map<string, number>;
  winnerStreak: number;
  questionNumber: number;
  totalQuestions: number;
  quizEnded: boolean;
  judgedByAI: boolean;
}

// In-memory storage for active quiz sessions
const activeSessions = new Map<string, QuizSession>();

/**
 * Normalize text for answer comparison
 */
function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' '); // Normalize whitespace
}

/**
 * Check if user's answer matches the correct answer
 */
function isCorrectAnswer(userAnswer: string, correctAnswer: string): boolean {
  const userNorm = normalizeAnswer(userAnswer);
  const correctNorm = normalizeAnswer(correctAnswer);

  // Empty answers are never correct
  if (!userNorm || !correctNorm) return false;

  // Exact match
  if (userNorm === correctNorm) return true;

  // User answer contains the correct answer (for short correct answers)
  if (correctNorm.length <= 20 && userNorm.includes(correctNorm)) return true;

  // Correct answer contains user answer (if user gave abbreviated version)
  if (userNorm.length >= 3 && correctNorm.includes(userNorm)) return true;

  return false;
}

/**
 * Heuristic: does a message look like a real answer attempt, vs. chatter?
 * Used to gate LLM judgement so we don't burn tokens on every message.
 */
export function looksLikeAnswerAttempt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 200) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return false;
  // Pure emoji/punctuation reactions
  if (!/[a-z0-9]/i.test(trimmed)) return false;
  return true;
}

/**
 * Ask a light LLM whether a user's answer is semantically equivalent to the
 * correct answer. Returns null if the call fails or the API key is missing.
 */
export async function verifyAnswerWithLLM(
  question: string,
  correctAnswer: string,
  userAnswer: string
): Promise<boolean | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  const prompt = `You are grading a flashcard quiz answer. Reply with ONLY "yes" or "no".

Is the user's answer a correct/equivalent response to the question? Accept synonyms, abbreviations, and minor wording differences. Reject answers that are wrong, off-topic, or only tangentially related.

Question: ${question}
Correct answer: ${correctAnswer}
User answer: ${userAnswer}

Answer (yes/no):`;

  try {
    const response = await fetch(AI_JUDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie Quiz Judge',
      },
      body: JSON.stringify({
        model: AI_JUDGE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      logger.warn(`Quiz LLM judge returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = (data.choices?.[0]?.message?.content || '').toLowerCase().trim();
    if (raw.startsWith('yes')) return true;
    if (raw.startsWith('no')) return false;
    return null;
  } catch (e) {
    logger.warn('Quiz LLM judge call failed:', e);
    return null;
  }
}

/**
 * Fetch a random flashcard from the API
 */
async function fetchRandomCard(deckId?: string): Promise<FlashcardResponse> {
  const url = deckId ? `${FLASHCARD_API_BASE}/random/${deckId}` : `${FLASHCARD_API_BASE}/random`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Deck "${deckId}" not found. Available: COMPUTERS, ELECTRICAL_AND_RADIO, POLITICS, RUBIKS_2x2, SAR_AND_WILDERNESS`
      );
    }
    throw new Error(`Failed to fetch flashcard: ${response.status}`);
  }

  return (await response.json()) as FlashcardResponse;
}

/**
 * Quiz Session Manager - handles all quiz game state
 */
export const quizSessionManager = {
  /**
   * Start a new quiz in a channel
   */
  async startQuiz(options: QuizStartOptions): Promise<QuizSession> {
    const {
      channelId,
      userId,
      deckId,
      questionCount = DEFAULT_QUESTION_COUNT,
      aiJudge = false,
      onTimeout,
    } = options;

    // Check if quiz already active
    if (activeSessions.has(channelId)) {
      throw new Error('A quiz is already active in this channel! Use /quiz stop to end it first.');
    }

    // Fetch first question
    const firstCard = await fetchRandomCard(deckId);

    const session: QuizSession = {
      channelId,
      deckId,
      currentCard: firstCard,
      questionNumber: 1,
      totalQuestions: questionCount,
      scores: new Map(),
      streaks: new Map(),
      bestStreaks: new Map(),
      answered: false,
      aiJudge,
      startedBy: userId,
      startedAt: new Date(),
      attemptedThisQuestion: new Set(),
      pendingJudgements: new Set(),
      onTimeout: onTimeout ? () => onTimeout(session) : undefined,
    };

    // Set question timeout
    if (session.onTimeout) {
      session.questionTimeout = setTimeout(() => {
        if (!session.answered && session.onTimeout) {
          session.onTimeout();
        }
      }, QUESTION_TIMEOUT_MS);
    }

    activeSessions.set(channelId, session);
    logger.info(`🎮 Quiz started in channel ${channelId} by ${userId} (deck: ${deckId || 'all'})`);

    return session;
  },

  /**
   * Get active session for a channel
   */
  getSession(channelId: string): QuizSession | undefined {
    return activeSessions.get(channelId);
  },

  /**
   * Check if a channel has an active quiz
   */
  hasActiveQuiz(channelId: string): boolean {
    return activeSessions.has(channelId);
  },

  /**
   * Record that a user attempted an answer (regardless of correctness).
   * Used so streaks can be reset for everyone who missed once the question ends.
   */
  recordAttempt(channelId: string, userId: string): void {
    const session = activeSessions.get(channelId);
    if (!session || session.answered) return;
    session.attemptedThisQuestion.add(userId);
  },

  /**
   * Check an answer from a user using fast string matching.
   * Returns an AnswerResult if correct, "maybe" if not matched but AI judge is
   * enabled and the message looks like an answer attempt, or null otherwise.
   */
  checkAnswer(
    channelId: string,
    userId: string,
    answer: string
  ): AnswerResult | 'maybe' | null {
    const session = activeSessions.get(channelId);

    if (!session || !session.currentCard || session.answered) {
      return null;
    }

    const correct = isCorrectAnswer(answer, session.currentCard.back);

    if (correct) {
      return this.awardCorrect(session, userId, false);
    }

    // String match failed. Signal that the LLM judge should weigh in if
    // enabled and the message looks like a genuine answer attempt.
    if (session.aiJudge && looksLikeAnswerAttempt(answer)) {
      session.attemptedThisQuestion.add(userId);
      return 'maybe';
    }

    return null;
  },

  /**
   * Ask the LLM to grade an answer that failed the string check. Safe to call
   * concurrently — only the first verified answer wins the question.
   */
  async checkAnswerWithAI(
    channelId: string,
    userId: string,
    answer: string
  ): Promise<AnswerResult | null> {
    const session = activeSessions.get(channelId);
    if (!session || !session.currentCard || session.answered || !session.aiJudge) {
      return null;
    }

    const judgementKey = `${session.questionNumber}:${userId}:${answer}`;
    if (session.pendingJudgements.has(judgementKey)) {
      return null;
    }
    session.pendingJudgements.add(judgementKey);

    const card = session.currentCard;
    const verdict = await verifyAnswerWithLLM(card.front, card.back, answer);

    // Re-fetch — the session may have ended while we awaited the LLM.
    const fresh = activeSessions.get(channelId);
    if (!fresh || fresh !== session || fresh.answered || fresh.currentCard !== card) {
      return null;
    }

    if (verdict !== true) {
      return null;
    }

    return this.awardCorrect(session, userId, true);
  },

  /**
   * Award a correct answer to a user and update scores/streaks.
   * Internal — callers should go through checkAnswer / checkAnswerWithAI.
   */
  awardCorrect(session: QuizSession, userId: string, judgedByAI: boolean): AnswerResult {
    session.answered = true;

    if (session.questionTimeout) {
      clearTimeout(session.questionTimeout);
      session.questionTimeout = undefined;
    }

    const currentScore = session.scores.get(userId) || 0;
    session.scores.set(userId, currentScore + 1);

    // Bump the winner's streak; reset everyone else who attempted this question.
    const winnerStreak = (session.streaks.get(userId) || 0) + 1;
    session.streaks.set(userId, winnerStreak);
    const winnerBest = Math.max(session.bestStreaks.get(userId) || 0, winnerStreak);
    session.bestStreaks.set(userId, winnerBest);

    for (const attemptedId of session.attemptedThisQuestion) {
      if (attemptedId !== userId) {
        session.streaks.set(attemptedId, 0);
      }
    }

    const quizEnded = session.questionNumber >= session.totalQuestions;

    logger.info(
      `✅ Quiz answer correct${judgedByAI ? ' (AI judged)' : ''}! Channel: ${session.channelId}, User: ${userId}, Streak: ${winnerStreak}, Q${session.questionNumber}/${session.totalQuestions}`
    );

    return {
      correct: true,
      isFirstCorrect: true,
      correctAnswer: session.currentCard!.back,
      currentScores: new Map(session.scores),
      currentStreaks: new Map(session.streaks),
      bestStreaks: new Map(session.bestStreaks),
      winnerStreak,
      questionNumber: session.questionNumber,
      totalQuestions: session.totalQuestions,
      quizEnded,
      judgedByAI,
    };
  },

  /**
   * Advance to the next question
   */
  async nextQuestion(channelId: string): Promise<QuizSession | null> {
    const session = activeSessions.get(channelId);

    if (!session) {
      return null;
    }

    // Check if quiz should end
    if (session.questionNumber >= session.totalQuestions) {
      this.endQuiz(channelId);
      return null;
    }

    // Fetch next card
    const nextCard = await fetchRandomCard(session.deckId);

    session.currentCard = nextCard;
    session.questionNumber++;
    session.answered = false;
    session.attemptedThisQuestion = new Set();
    session.pendingJudgements = new Set();

    // Set new timeout
    if (session.onTimeout) {
      session.questionTimeout = setTimeout(() => {
        if (!session.answered && session.onTimeout) {
          session.onTimeout();
        }
      }, QUESTION_TIMEOUT_MS);
    }

    logger.info(
      `🎮 Quiz next question: ${channelId} Q${session.questionNumber}/${session.totalQuestions}`
    );

    return session;
  },

  /**
   * Skip current question (no points awarded)
   */
  async skipQuestion(
    channelId: string
  ): Promise<{ skippedAnswer: string; session: QuizSession | null }> {
    const session = activeSessions.get(channelId);

    if (!session || !session.currentCard) {
      return { skippedAnswer: '', session: null };
    }

    const skippedAnswer = session.currentCard.back;

    // Clear timeout
    if (session.questionTimeout) {
      clearTimeout(session.questionTimeout);
      session.questionTimeout = undefined;
    }

    session.answered = true;
    // Skipping = nobody got it. Reset streaks for anyone who attempted.
    for (const attemptedId of session.attemptedThisQuestion) {
      session.streaks.set(attemptedId, 0);
    }

    // Move to next question or end
    const nextSession = await this.nextQuestion(channelId);

    return { skippedAnswer, session: nextSession };
  },

  /**
   * Handle question timeout (no one answered)
   */
  async handleTimeout(
    channelId: string
  ): Promise<{ answer: string; nextSession: QuizSession | null }> {
    const session = activeSessions.get(channelId);

    if (!session || !session.currentCard) {
      return { answer: '', nextSession: null };
    }

    const answer = session.currentCard.back;
    session.answered = true;
    // Timeout = nobody got it. Reset streaks for anyone who attempted.
    for (const attemptedId of session.attemptedThisQuestion) {
      session.streaks.set(attemptedId, 0);
    }

    // Move to next question
    const nextSession = await this.nextQuestion(channelId);

    return { answer, nextSession };
  },

  /**
   * End a quiz and return final scores
   */
  endQuiz(channelId: string): Map<string, number> | null {
    const session = activeSessions.get(channelId);

    if (!session) {
      return null;
    }

    // Clear any pending timeout
    if (session.questionTimeout) {
      clearTimeout(session.questionTimeout);
    }

    const finalScores = new Map(session.scores);
    activeSessions.delete(channelId);

    logger.info(
      `🎮 Quiz ended in channel ${channelId}. Final scores: ${JSON.stringify([...finalScores])}`
    );

    return finalScores;
  },

  /**
   * Get current scores for a channel
   */
  getScores(channelId: string): Map<string, number> | null {
    const session = activeSessions.get(channelId);
    return session ? new Map(session.scores) : null;
  },

  /**
   * Format scores for display
   */
  formatScores(
    scores: Map<string, number>,
    userMentions?: Map<string, string>,
    streaks?: Map<string, number>
  ): string {
    if (scores.size === 0) {
      return 'No scores yet!';
    }

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

    return sorted
      .map(([userId, score], i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        const name = userMentions?.get(userId) || `<@${userId}>`;
        const streak = streaks?.get(userId) || 0;
        const streakBadge = streak >= 2 ? ` 🔥${streak}` : '';
        return `${medal} ${name}: ${score}${streakBadge}`;
      })
      .join(' | ');
  },

  /**
   * Format a single user's streak as a badge, e.g. " 🔥3" or "" when below threshold.
   */
  formatStreakBadge(streak: number): string {
    if (streak >= 5) return ` 🔥🔥${streak} streak!`;
    if (streak >= 2) return ` 🔥${streak} streak`;
    return '';
  },

  /**
   * Get the winner(s) from final scores
   */
  getWinners(scores: Map<string, number>): string[] {
    if (scores.size === 0) return [];

    const maxScore = Math.max(...scores.values());
    return [...scores.entries()]
      .filter(([, score]) => score === maxScore)
      .map(([userId]) => userId);
  },

  /**
   * Return best streaks (current session) sorted descending. Useful for the
   * end-of-quiz recap so the "streak champion" can be celebrated alongside
   * the points winner.
   */
  getStreakLeaders(bestStreaks: Map<string, number>): Array<[string, number]> {
    return [...bestStreaks.entries()]
      .filter(([, streak]) => streak >= 2)
      .sort((a, b) => b[1] - a[1]);
  },
};

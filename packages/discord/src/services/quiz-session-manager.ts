import { logger } from '@coachartie/shared';

const FLASHCARD_API_BASE = 'https://ejfox.com/api/flashcards';
const DEFAULT_QUESTION_COUNT = 10;
const QUESTION_TIMEOUT_MS = 30000; // 30 seconds per question

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
  scores: Map<string, number>; // oderId -> score
  answered: boolean;
  startedBy: string;
  startedAt: Date;
  questionTimeout?: ReturnType<typeof setTimeout>;
  onTimeout?: () => void; // Callback when question times out
}

export interface QuizStartOptions {
  channelId: string;
  userId: string;
  deckId?: string;
  questionCount?: number;
  onTimeout?: (session: QuizSession) => void;
}

export interface AnswerResult {
  correct: boolean;
  isFirstCorrect: boolean;
  correctAnswer: string;
  currentScores: Map<string, number>;
  questionNumber: number;
  totalQuestions: number;
  quizEnded: boolean;
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
      answered: false,
      startedBy: userId,
      startedAt: new Date(),
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
   * Check an answer from a user
   */
  checkAnswer(channelId: string, oderId: string, answer: string): AnswerResult | null {
    const session = activeSessions.get(channelId);

    if (!session || !session.currentCard || session.answered) {
      return null;
    }

    const correct = isCorrectAnswer(answer, session.currentCard.back);

    if (!correct) {
      return null; // Don't return anything for wrong answers
    }

    // First correct answer!
    session.answered = true;

    // Clear timeout
    if (session.questionTimeout) {
      clearTimeout(session.questionTimeout);
      session.questionTimeout = undefined;
    }

    // Award point
    const currentScore = session.scores.get(oderId) || 0;
    session.scores.set(oderId, currentScore + 1);

    const quizEnded = session.questionNumber >= session.totalQuestions;

    logger.info(
      `✅ Quiz answer correct! Channel: ${channelId}, User: ${oderId}, Q${session.questionNumber}/${session.totalQuestions}`
    );

    return {
      correct: true,
      isFirstCorrect: true,
      correctAnswer: session.currentCard.back,
      currentScores: new Map(session.scores),
      questionNumber: session.questionNumber,
      totalQuestions: session.totalQuestions,
      quizEnded,
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
  formatScores(scores: Map<string, number>, userMentions?: Map<string, string>): string {
    if (scores.size === 0) {
      return 'No scores yet!';
    }

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

    return sorted
      .map(([oderId, score], i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        const name = userMentions?.get(oderId) || `<@${oderId}>`;
        return `${medal} ${name}: ${score}`;
      })
      .join(' | ');
  },

  /**
   * Get the winner(s) from final scores
   */
  getWinners(scores: Map<string, number>): string[] {
    if (scores.size === 0) return [];

    const maxScore = Math.max(...scores.values());
    return [...scores.entries()]
      .filter(([, score]) => score === maxScore)
      .map(([oderId]) => oderId);
  },
};

import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Quiz Game capability - Informs users about quiz functionality
 *
 * The actual quiz game runs through Discord's slash commands and message detection.
 * This capability helps the LLM understand and explain the quiz feature to users.
 *
 * Users can:
 * - Use /quiz start [deck] [count] to start a quiz
 * - Use /quiz stop to end a quiz
 * - Use /quiz scores to see the leaderboard
 * - Use /quiz skip to skip a question
 * - Type answers in chat to compete
 *
 * Available decks: COMPUTERS, ELECTRICAL_AND_RADIO, POLITICS, RUBIKS_2x2, SAR_AND_WILDERNESS
 */
export const quizGameCapability: RegisteredCapability = {
  name: 'quiz-game',
  emoji: '🎮',
  supportedActions: ['info', 'help'],
  description:
    'Channel-wide quiz games where users race to answer flashcard questions. Use /quiz command or ask Artie to start a quiz!',
  examples: [
    '<capability name="quiz-game" action="info" /> - Explain how quizzes work',
    '<capability name="quiz-game" action="help" /> - Show quiz commands',
  ],
  handler: async (params) => {
    const { action } = params;

    logger.info(`🎮 Quiz game capability called with action: ${action}`);

    switch (action) {
      case 'info':
        return `🎮 **Quiz Game**

The quiz game lets users compete to answer flashcard questions. First correct answer wins the point!

**How to play:**
1. Start a quiz with \`/quiz start\` or ask me to "start a quiz"
2. I'll post questions one at a time
3. Type your answer in chat - first correct answer wins!
4. After all questions, I'll announce the winner

**Available decks:**
- COMPUTERS - Vim, Git, algorithms, networking
- ELECTRICAL_AND_RADIO - Ham radio, electronics, circuits
- POLITICS - US government, political theory
- RUBIKS_2x2 - Rubik's cube algorithms
- SAR_AND_WILDERNESS - Search & rescue, survival`;

      case 'help':
        return `🎮 **Quiz Commands**

\`/quiz start [deck] [questions]\` - Start a new quiz
\`/quiz stop\` - End the current quiz
\`/quiz scores\` - Show the leaderboard
\`/quiz skip\` - Skip the current question

**Examples:**
- \`/quiz start\` - Random questions from all decks
- \`/quiz start COMPUTERS 5\` - 5 computer questions
- \`/quiz start ELECTRICAL_AND_RADIO 10\` - 10 radio questions

Or just say "quiz me on computers" or "start a quiz"!`;

      default:
        return `Use \`/quiz start\` to start a quiz game, or ask me to "start a quiz on [topic]"!`;
    }
  },
};

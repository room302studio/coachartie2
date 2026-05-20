import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  InteractionResponse,
  Channel,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { quizSessionManager, QuizSession } from '../services/quiz-session-manager.js';
import { buildLiveQuizMessage, buildQuizSummary } from '../services/quiz-embed.js';
import {
  ensureDailyQuizTables,
  getOrCreateDailyPuzzle,
  getServerLeaderboard,
  getUserPlay,
  startUserPlay,
  todayKey,
  DAILY_QUESTION_COUNT,
  type LeaderboardScope,
} from '../services/daily-quiz.js';
import {
  buildDailyGameMessage,
  buildDailyResultMessage,
  buildLeaderboardMessage,
} from '../services/daily-quiz-embed.js';

export const quizCommand = {
  data: new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Start a quiz game in this channel')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('Start a new quiz')
        .addStringOption((option) =>
          option
            .setName('deck')
            .setDescription('Which deck to quiz from')
            .setRequired(false)
            .addChoices(
              { name: 'All Decks (Random)', value: 'all' },
              { name: 'Computers', value: 'COMPUTERS' },
              { name: 'Electrical & Radio', value: 'ELECTRICAL_AND_RADIO' },
              { name: 'Politics', value: 'POLITICS' },
              { name: "Rubik's 2x2", value: 'RUBIKS_2x2' },
              { name: 'Search & Rescue', value: 'SAR_AND_WILDERNESS' }
            )
        )
        .addIntegerOption((option) =>
          option
            .setName('questions')
            .setDescription('Number of questions (1-50)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(50)
        )
        .addBooleanOption((option) =>
          option
            .setName('ai_judge')
            .setDescription('Use a light LLM to accept fuzzy/equivalent answers (default: off)')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stop').setDescription('End the current quiz')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('scores').setDescription('Show current quiz scores')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('skip').setDescription('Skip the current question')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('daily')
        .setDescription("Play today's solo daily quiz (Wordle-style — share your result after)")
        .addStringOption((option) =>
          option
            .setName('deck')
            .setDescription('Which deck to play today (default: all)')
            .setRequired(false)
            .addChoices(
              { name: 'All Decks (Random)', value: 'all' },
              { name: 'Computers', value: 'COMPUTERS' },
              { name: 'Electrical & Radio', value: 'ELECTRICAL_AND_RADIO' },
              { name: 'Politics', value: 'POLITICS' },
              { name: "Rubik's 2x2", value: 'RUBIKS_2x2' },
              { name: 'Search & Rescue', value: 'SAR_AND_WILDERNESS' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('leaderboard')
        .setDescription("This server's daily-quiz leaderboard")
        .addStringOption((option) =>
          option
            .setName('scope')
            .setDescription('Time range (default: all-time)')
            .setRequired(false)
            .addChoices(
              { name: "Today's Daily", value: 'today' },
              { name: 'This Week', value: 'week' },
              { name: 'All-Time', value: 'alltime' }
            )
        )
    ),

  async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<InteractionResponse<boolean> | undefined> {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'start':
          return await handleStart(interaction);
        case 'stop':
          return await handleStop(interaction);
        case 'scores':
          return await handleScores(interaction);
        case 'skip':
          return await handleSkip(interaction);
        case 'daily':
          return await handleDaily(interaction);
        case 'leaderboard':
          return await handleLeaderboard(interaction);
        default:
          return await interaction.reply({
            content: 'Unknown subcommand',
            ephemeral: true,
          });
      }
    } catch (error) {
      logger.error('Quiz command error:', error);

      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

      return await interaction.reply({
        content: `❌ ${errorMessage}`,
        ephemeral: true,
      });
    }
  },
};

/**
 * Edit the live quiz embed in place. Falls back to a new message if the
 * tracked host message is gone.
 */
export async function refreshLiveQuiz(channel: Channel, session: QuizSession): Promise<void> {
  if (!('send' in channel) || !channel.isTextBased()) return;
  const payload = buildLiveQuizMessage(session);

  if (session.questionMessageId) {
    try {
      const existing = await channel.messages.fetch(session.questionMessageId);
      await existing.edit(payload);
      return;
    } catch (e) {
      logger.warn('Quiz embed message gone, re-posting:', e);
    }
  }
  const sent = await channel.send(payload);
  quizSessionManager.setQuestionMessage(session.channelId, sent.id);
}

/**
 * End the quiz, replace the live embed with a shareable summary card.
 */
export async function postQuizSummary(channel: Channel, channelId: string): Promise<void> {
  if (!('send' in channel) || !channel.isTextBased()) return;
  const session = quizSessionManager.getSession(channelId);
  const finalScores = quizSessionManager.endQuiz(channelId);
  if (!session || !finalScores) return;

  const payload = buildQuizSummary(session, finalScores);

  if (session.questionMessageId) {
    try {
      const existing = await channel.messages.fetch(session.questionMessageId);
      await existing.edit(payload);
      return;
    } catch (e) {
      logger.warn('Quiz host message missing for summary, posting fresh:', e);
    }
  }
  await channel.send(payload);
}

async function handleStart(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const deckOption = interaction.options.getString('deck');
  const questionsOption = interaction.options.getInteger('questions');
  const aiJudgeOption = interaction.options.getBoolean('ai_judge');

  const deckId = deckOption === 'all' ? undefined : deckOption || undefined;
  const questionCount = questionsOption || 10;
  const aiJudge = aiJudgeOption ?? false;

  if (quizSessionManager.hasActiveQuiz(interaction.channelId)) {
    return await interaction.reply({
      content: '❌ A quiz is already active in this channel! Use `/quiz stop` to end it first.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const session = await quizSessionManager.startQuiz({
      channelId: interaction.channelId,
      userId: interaction.user.id,
      deckId,
      questionCount,
      aiJudge,
      onTimeout: async (timedOutSession: QuizSession) => {
        try {
          const { answer, nextSession } = await quizSessionManager.handleTimeout(
            interaction.channelId
          );
          quizSessionManager.setBanner(
            interaction.channelId,
            `⏰ Time's up! The answer was **${answer}**`
          );

          if (!interaction.channel) return;
          if (nextSession) {
            await refreshLiveQuiz(interaction.channel, nextSession);
          } else {
            await postQuizSummary(interaction.channel, interaction.channelId);
          }
        } catch (e) {
          logger.error('Failed to handle quiz timeout:', e);
        }
      },
    });

    quizSessionManager.rememberUsername(
      interaction.channelId,
      interaction.user.id,
      interaction.user.username
    );

    const payload = buildLiveQuizMessage(session);
    const sent = await interaction.editReply(payload);
    quizSessionManager.setQuestionMessage(interaction.channelId, sent.id);

    return undefined;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start quiz';
    await interaction.editReply({
      content: `❌ ${errorMessage}`,
    });
    return undefined;
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const session = quizSessionManager.getSession(interaction.channelId);
  if (!session) {
    return await interaction.reply({
      content: '❌ No active quiz in this channel.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();
  if (interaction.channel) {
    await postQuizSummary(interaction.channel, interaction.channelId);
  }
  await interaction.editReply({ content: `🛑 Quiz ended by ${interaction.user.username}.` });
  return undefined;
}

async function handleScores(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const session = quizSessionManager.getSession(interaction.channelId);

  if (!session) {
    return await interaction.reply({
      content: '❌ No active quiz in this channel.',
      ephemeral: true,
    });
  }

  const payload = buildLiveQuizMessage(session);
  return await interaction.reply({ ...payload, ephemeral: true });
}

async function handleSkip(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const { skippedAnswer, session } = await quizSessionManager.skipQuestion(interaction.channelId);

  if (!skippedAnswer) {
    return await interaction.reply({
      content: '❌ No active quiz or no current question to skip.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });
  quizSessionManager.setBanner(
    interaction.channelId,
    `⏭️ Skipped by ${interaction.user.username}. Answer was **${skippedAnswer}**`
  );

  if (interaction.channel) {
    if (session) {
      await refreshLiveQuiz(interaction.channel, session);
    } else {
      await postQuizSummary(interaction.channel, interaction.channelId);
    }
  }
  await interaction.editReply({ content: '⏭️ Skipped.' });
  return undefined;
}

/**
 * Solo, async, once-per-day quiz. Ephemeral — only the invoker sees their
 * game state. Wordle-style: everyone gets the same N cards for the day,
 * play whenever, opt-in share to the channel.
 */
async function handleDaily(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const deckOption = interaction.options.getString('deck');
  const deck = deckOption && deckOption !== 'all' ? deckOption : '';
  const date = todayKey();

  await interaction.deferReply({ ephemeral: true });
  ensureDailyQuizTables();

  let puzzle;
  try {
    puzzle = await getOrCreateDailyPuzzle(date, deck);
  } catch (e) {
    logger.error('Failed to fetch daily puzzle:', e);
    await interaction.editReply({
      content: '❌ Failed to load today\'s puzzle. Try again in a minute.',
    });
    return undefined;
  }

  if (!puzzle || puzzle.cards.length === 0) {
    await interaction.editReply({
      content: '❌ Could not load today\'s puzzle. The flashcard API may be down.',
    });
    return undefined;
  }

  let play = getUserPlay(interaction.user.id, date, deck);
  if (!play) {
    play = startUserPlay(
      interaction.user.id,
      interaction.user.username,
      date,
      deck,
      interaction.guildId
    );
  }

  if (play.completed) {
    const payload = buildDailyResultMessage(play, puzzle, interaction.user.username);
    await interaction.editReply(payload);
    return undefined;
  }

  // Truncate cards array to the question count we're enforcing — guards
  // against any oddness in cached puzzles from earlier versions.
  puzzle.cards = puzzle.cards.slice(0, DAILY_QUESTION_COUNT);

  const payload = buildDailyGameMessage(play, puzzle);
  await interaction.editReply(payload);
  return undefined;
}

/**
 * Public server leaderboard for the daily quiz.
 */
async function handleLeaderboard(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  if (!interaction.guildId) {
    return await interaction.reply({
      content: '⚠️ Run this in a server channel — DMs don\'t have a leaderboard.',
      ephemeral: true,
    });
  }

  const scopeOption = (interaction.options.getString('scope') as LeaderboardScope) || 'alltime';
  ensureDailyQuizTables();
  const rows = getServerLeaderboard(interaction.guildId, scopeOption);
  const guildName = interaction.guild?.name || 'This server';
  const payload = buildLeaderboardMessage(rows, scopeOption, guildName);
  return await interaction.reply(payload);
}

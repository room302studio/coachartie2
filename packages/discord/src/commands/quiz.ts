import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionResponse,
  TextChannel,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { quizSessionManager, QuizSession } from '../services/quiz-session-manager.js';

const AVAILABLE_DECKS = ['COMPUTERS', 'ELECTRICAL_AND_RADIO', 'POLITICS', 'RUBIKS_2x2', 'SAR_AND_WILDERNESS'];

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
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stop').setDescription('End the current quiz')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('scores').setDescription('Show current quiz scores')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('skip').setDescription('Skip the current question')
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

async function handleStart(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const deckOption = interaction.options.getString('deck');
  const questionsOption = interaction.options.getInteger('questions');

  const deckId = deckOption === 'all' ? undefined : deckOption || undefined;
  const questionCount = questionsOption || 10;

  // Check if quiz already active
  if (quizSessionManager.hasActiveQuiz(interaction.channelId)) {
    return await interaction.reply({
      content: '❌ A quiz is already active in this channel! Use `/quiz stop` to end it first.',
      ephemeral: true,
    });
  }

  // Defer reply since starting quiz might take a moment
  await interaction.deferReply();

  try {
    const session = await quizSessionManager.startQuiz({
      channelId: interaction.channelId,
      userId: interaction.user.id,
      deckId,
      questionCount,
      onTimeout: async (timedOutSession: QuizSession) => {
        // Handle timeout - reveal answer and move to next question
        try {
          const { answer, nextSession } = await quizSessionManager.handleTimeout(interaction.channelId);

          let response = `⏰ **Time's up!**\nThe answer was: **${answer}**\n`;
          response += `📊 ${quizSessionManager.formatScores(timedOutSession.scores)}\n`;

          if (nextSession && nextSession.currentCard) {
            response += `\n---\n\n`;
            response += `**Question ${nextSession.questionNumber}/${nextSession.totalQuestions}**\n`;
            response += nextSession.currentCard.front;
            if (nextSession.currentCard.hints.length > 0) {
              response += `\n\n_💡 Hints available: ${nextSession.currentCard.hints.length}_`;
            }
          } else {
            // Quiz ended
            const scores = quizSessionManager.endQuiz(interaction.channelId);
            if (scores && scores.size > 0) {
              response += `\n🏁 **Quiz Complete!**\n`;
              const winners = quizSessionManager.getWinners(scores);
              if (winners.length === 1) {
                response += `🎉 **Winner: <@${winners[0]}>!**`;
              } else if (winners.length > 1) {
                response += `🎉 **It's a tie! Winners: ${winners.map((w: string) => `<@${w}>`).join(', ')}**`;
              }
            } else {
              response += `\n🏁 **Quiz Complete!** No one scored any points.`;
            }
          }

          if (interaction.channel && 'send' in interaction.channel) {
            await interaction.channel.send(response);
          }
        } catch (e) {
          logger.error('Failed to handle quiz timeout:', e);
        }
      },
    });

    const deckDisplay = session.deckId || 'All Decks';

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle('🎮 Quiz Started!')
      .setDescription(
        `**Deck:** ${deckDisplay}\n**Questions:** ${session.totalQuestions}\n\nType your answers in chat - first correct answer wins!`
      )
      .setFooter({ text: `Started by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Send first question as a separate message
    if (session.currentCard) {
      let questionMsg = `**Question 1/${session.totalQuestions}**\n`;
      questionMsg += session.currentCard.front;
      if (session.currentCard.hints.length > 0) {
        questionMsg += `\n\n_💡 Hints available: ${session.currentCard.hints.length}_`;
      }
      if (interaction.channel && 'send' in interaction.channel) {
        await interaction.channel.send(questionMsg);
      }
    }

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
  const scores = quizSessionManager.endQuiz(interaction.channelId);

  if (!scores) {
    return await interaction.reply({
      content: '❌ No active quiz in this channel.',
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0xff9900)
    .setTitle('🛑 Quiz Stopped')
    .setDescription(
      scores.size > 0
        ? `**Final Scores:**\n${quizSessionManager.formatScores(scores)}`
        : 'No scores recorded.'
    )
    .setFooter({ text: `Stopped by ${interaction.user.username}` })
    .setTimestamp();

  if (scores.size > 0) {
    const winners = quizSessionManager.getWinners(scores);
    if (winners.length === 1) {
      embed.addFields({ name: '🏆 Winner', value: `<@${winners[0]}>` });
    } else if (winners.length > 1) {
      embed.addFields({
        name: '🏆 Tied Winners',
        value: winners.map((w: string) => `<@${w}>`).join(', '),
      });
    }
  }

  return await interaction.reply({ embeds: [embed] });
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

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('📊 Quiz Scores')
    .setDescription(
      session.scores.size > 0
        ? quizSessionManager.formatScores(session.scores)
        : 'No scores yet - be the first to answer!'
    )
    .addFields(
      {
        name: 'Progress',
        value: `Question ${session.questionNumber}/${session.totalQuestions}`,
        inline: true,
      },
      {
        name: 'Deck',
        value: session.deckId || 'All Decks',
        inline: true,
      }
    )
    .setTimestamp();

  return await interaction.reply({ embeds: [embed] });
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

  await interaction.reply({
    content: `⏭️ **Question skipped!**\nThe answer was: **${skippedAnswer}**`,
  });

  if (session && session.currentCard) {
    // Send next question
    let questionMsg = `\n**Question ${session.questionNumber}/${session.totalQuestions}**\n`;
    questionMsg += session.currentCard.front;
    if (session.currentCard.hints.length > 0) {
      questionMsg += `\n\n_💡 Hints available: ${session.currentCard.hints.length}_`;
    }
    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send(questionMsg);
    }
  } else {
    // Quiz ended
    const scores = quizSessionManager.getScores(interaction.channelId);
    if (scores) {
      const finalScores = quizSessionManager.endQuiz(interaction.channelId);
      if (finalScores && finalScores.size > 0) {
        let endMsg = `🏁 **Quiz Complete!**\n`;
        endMsg += quizSessionManager.formatScores(finalScores);
        const winners = quizSessionManager.getWinners(finalScores);
        if (winners.length === 1) {
          endMsg += `\n\n🎉 **Winner: <@${winners[0]}>!**`;
        } else if (winners.length > 1) {
          endMsg += `\n\n🎉 **It's a tie! Winners: ${winners.map((w: string) => `<@${w}>`).join(', ')}**`;
        }
        if (interaction.channel && 'send' in interaction.channel) {
          await interaction.channel.send(endMsg);
        }
      }
    }
  }

  return undefined;
}

import {
  Client,
  Events,
  Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  SelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { linkPhoneCommand } from '../commands/link-phone.js';
import { verifyPhoneCommand } from '../commands/verify-phone.js';
import { unlinkPhoneCommand } from '../commands/unlink-phone.js';
import { linkEmailCommand } from '../commands/link-email.js';
import { unlinkEmailCommand } from '../commands/unlink-email.js';
import { statusCommand } from '../commands/status.js';
import { botStatusCommand } from '../commands/bot-status.js';
import { modelsCommand } from '../commands/models.js';
import { memoryCommand } from '../commands/memory.js';
import { usageCommand } from '../commands/usage.js';
import { debugCommand } from '../commands/debug.js';
import * as syncDiscussionsCommand from '../commands/sync-discussions.js';
import { quizCommand, refreshLiveQuiz, postQuizSummary } from '../commands/quiz.js';
import { parseQuizButtonId } from '../services/quiz-embed.js';
import { quizSessionManager, isCorrectAnswer } from '../services/quiz-session-manager.js';
import {
  parseDailyCustomId,
  buildDailyGameMessage,
  buildDailyResultMessage,
  buildDailyShareMessage,
  buildGuessModal,
  DAILY_MODAL_INPUT,
} from '../services/daily-quiz-embed.js';
import {
  getOrCreateDailyPuzzle,
  getUserPlay,
  recordGuess,
  markCompleted,
  markShared,
  DAILY_QUESTION_COUNT,
} from '../services/daily-quiz.js';
import { watchRepoCommand } from '../commands/watch-repo.js';
import { unwatchRepoCommand } from '../commands/unwatch-repo.js';
import { listWatchesCommand } from '../commands/list-watches.js';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';

const commands = new Map([
  ['link-phone', linkPhoneCommand],
  ['verify-phone', verifyPhoneCommand],
  ['unlink-phone', unlinkPhoneCommand],
  ['link-email', linkEmailCommand],
  ['unlink-email', unlinkEmailCommand],
  ['status', statusCommand],
  ['bot-status', botStatusCommand],
  ['models', modelsCommand],
  ['memory', memoryCommand],
  ['usage', usageCommand],
  ['debug', debugCommand],
  ['sync-discussions', syncDiscussionsCommand],
  ['quiz', quizCommand],
  ['watch-repo', watchRepoCommand],
  ['unwatch-repo', unwatchRepoCommand],
  ['list-watches', listWatchesCommand],
] as any);

export function setupInteractionHandler(client: Client) {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle different types of interactions
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  });

  logger.info('Interaction handler setup complete with telemetry tracking');
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  // Generate correlation ID for command tracking
  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);

  const command = commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command [${shortId}]:`, {
      correlationId,
      command: interaction.commandName,
      userId: interaction.user.id,
    });
    telemetry.logEvent(
      'command_unknown',
      {
        command: interaction.commandName,
      },
      correlationId,
      interaction.user.id,
      undefined,
      false
    );
    return;
  }

  const startTime = Date.now();

  try {
    logger.info(`Executing command [${shortId}]:`, {
      correlationId,
      command: interaction.commandName,
      userId: interaction.user.id,
      username: interaction.user.username,
      guildId: interaction.guild?.id,
      service: 'discord',
    });

    telemetry.logEvent(
      'command_started',
      {
        command: interaction.commandName,
        guildId: interaction.guild?.id,
      },
      correlationId,
      interaction.user.id
    );

    await (command as any).execute(interaction);

    const duration = Date.now() - startTime;
    logger.info(`Command completed [${shortId}]:`, {
      correlationId,
      command: interaction.commandName,
      duration: `${duration}ms`,
      userId: interaction.user.id,
    });

    telemetry.logEvent(
      'command_completed',
      {
        command: interaction.commandName,
        duration,
      },
      correlationId,
      interaction.user.id,
      duration,
      true
    );
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(`Command failed [${shortId}]:`, {
      correlationId,
      command: interaction.commandName,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${duration}ms`,
      userId: interaction.user.id,
    });

    telemetry.logEvent(
      'command_failed',
      {
        command: interaction.commandName,
        error: error instanceof Error ? error.message : String(error),
        duration,
      },
      correlationId,
      interaction.user.id,
      duration,
      false
    );

    const errorMessage = `❌ There was an error executing this command! [${shortId}]`;

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, {
        correlationId,
        replyError: replyError instanceof Error ? replyError.message : String(replyError),
      });
    }
  }
}

/**
 * Button interaction adapter - tiny bridge to unified processor
 * Replaces ~150 lines of duplicate logic with ~15 lines
 */
async function handleButtonInteraction(interaction: ButtonInteraction) {
  const buttonText = (interaction.component as any)?.label || interaction.customId;

  // Quiz buttons own the live embed — handle them before the generic intent
  // processor so we don't accidentally send "Hint" / "Skip" to the LLM.
  const quizAction = parseQuizButtonId(interaction.customId);
  if (quizAction) {
    await handleQuizButton(interaction, quizAction);
    return;
  }

  // Daily-quiz buttons (Guess opens modal, Share posts public card).
  const dailyId = parseDailyCustomId(interaction.customId);
  if (dailyId) {
    await handleDailyQuizButton(interaction, dailyId);
    return;
  }

  // Check if this is an ask-question response
  if (interaction.customId.startsWith('ask_')) {
    await handleAskQuestionResponse(interaction);
    return;
  }

  await interaction.deferReply();

  await processUserIntent({
    content: buttonText,
    userId: interaction.user.id,
    username: interaction.user.username,
    source: 'button',
    metadata: { customId: interaction.customId },

    respond: async (content: string) => {
      await interaction.editReply(`🔘 **${buttonText}**\n\n${content}`);
    },

    updateProgress: async (status: string) => {
      await interaction.editReply(`🔄 **${buttonText}**\n\n${status}`);
    },
  });
}

/**
 * Select menu interaction adapter - tiny bridge to unified processor
 * Replaces ~150 lines of duplicate logic with ~15 lines
 */
async function handleSelectMenuInteraction(interaction: SelectMenuInteraction) {
  const selectedValue = interaction.values[0];
  const selectedOption = interaction.component?.options?.find((opt) => opt.value === selectedValue);
  const selectedLabel = selectedOption?.label || selectedValue;

  // Check if this is an ask-question response
  if (interaction.customId.startsWith('ask_')) {
    await handleAskQuestionResponse(interaction);
    return;
  }

  await interaction.deferReply();

  await processUserIntent({
    content: selectedLabel,
    userId: interaction.user.id,
    username: interaction.user.username,
    source: 'select',
    metadata: {
      customId: interaction.customId,
      selectedValue,
      selectedLabel,
    },

    respond: async (content: string) => {
      await interaction.editReply(`📋 **${selectedLabel}**\n\n${content}`);
    },

    updateProgress: async (status: string) => {
      await interaction.editReply(`🔄 **${selectedLabel}**\n\n${status}`);
    },
  });
}

/**
 * Handle the action buttons on the live quiz embed (Hint / Skip / End /
 * Play Again). Each action mutates the session, then re-renders the embed
 * in place — the Wordle-style "one host message" pattern.
 */
async function handleQuizButton(
  interaction: ButtonInteraction,
  action: ReturnType<typeof parseQuizButtonId>
): Promise<void> {
  const channelId = interaction.channelId;
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }

  quizSessionManager.rememberUsername(
    channelId,
    interaction.user.id,
    interaction.user.username
  );

  try {
    switch (action) {
      case 'hint': {
        const session = quizSessionManager.getSession(channelId);
        if (!session) {
          await interaction.reply({ content: 'No active quiz.', ephemeral: true });
          return;
        }
        const hint = quizSessionManager.revealHint(channelId);
        if (!hint) {
          await interaction.reply({ content: 'No more hints available.', ephemeral: true });
          return;
        }
        await interaction.deferUpdate();
        await refreshLiveQuiz(channel, session);
        return;
      }

      case 'skip': {
        const session = quizSessionManager.getSession(channelId);
        if (!session) {
          await interaction.reply({ content: 'No active quiz.', ephemeral: true });
          return;
        }
        await interaction.deferUpdate();
        const { skippedAnswer, session: next } =
          await quizSessionManager.skipQuestion(channelId);
        quizSessionManager.setBanner(
          channelId,
          `⏭️ Skipped by ${interaction.user.username}. Answer was **${skippedAnswer}**`
        );
        if (next) {
          await refreshLiveQuiz(channel, next);
        } else {
          await postQuizSummary(channel, channelId);
        }
        return;
      }

      case 'end': {
        const session = quizSessionManager.getSession(channelId);
        if (!session) {
          await interaction.reply({ content: 'No active quiz.', ephemeral: true });
          return;
        }
        await interaction.deferUpdate();
        quizSessionManager.setBanner(
          channelId,
          `🛑 Ended by ${interaction.user.username}`
        );
        await postQuizSummary(channel, channelId);
        return;
      }

      case 'again': {
        // Lightweight hint to re-run /quiz start — re-launching a quiz needs
        // the original options (deck, count, ai_judge) so we don't auto-start
        // with stale parameters.
        await interaction.reply({
          content: '🔁 Run `/quiz start` to play another round!',
          ephemeral: true,
        });
        return;
      }
    }
  } catch (error) {
    logger.error('Quiz button error:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Something went wrong handling that button.',
          ephemeral: true,
        });
      }
    } catch {
      // already replied
    }
  }
}

/**
 * Daily quiz button dispatcher. Guess → opens a modal. Share → posts the
 * public emoji-grid card and disables the share button on the ephemeral.
 */
async function handleDailyQuizButton(
  interaction: ButtonInteraction,
  parsed: NonNullable<ReturnType<typeof parseDailyCustomId>>
): Promise<void> {
  const { action, date, deck } = parsed;
  const userId = interaction.user.id;

  try {
    if (action === 'guess') {
      const play = getUserPlay(userId, date, deck);
      if (!play || play.completed) {
        await interaction.reply({
          content: '⚠️ This game is finished. Start tomorrow\'s with `/quiz daily`.',
          ephemeral: true,
        });
        return;
      }
      await interaction.showModal(buildGuessModal(date, deck, play.currentQuestion + 1));
      return;
    }

    if (action === 'share') {
      const play = getUserPlay(userId, date, deck);
      if (!play || !play.completed) {
        await interaction.reply({
          content: '⚠️ Finish the quiz first.',
          ephemeral: true,
        });
        return;
      }
      if (play.shared) {
        await interaction.reply({ content: 'Already shared today.', ephemeral: true });
        return;
      }

      await interaction.deferUpdate();

      if (interaction.channel && 'send' in interaction.channel) {
        await interaction.channel.send(buildDailyShareMessage(play, interaction.user.username));
      }
      markShared(userId, date, deck);

      const puzzle = await getOrCreateDailyPuzzle(date, deck);
      if (puzzle) {
        const refreshed = getUserPlay(userId, date, deck);
        if (refreshed) {
          await interaction.editReply(
            buildDailyResultMessage(refreshed, puzzle, interaction.user.username)
          );
        }
      }
      return;
    }

    // replay or unknown: just acknowledge
    await interaction.reply({
      content: '🔁 Come back tomorrow for the next daily!',
      ephemeral: true,
    });
  } catch (error) {
    logger.error('Daily quiz button error:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Something went wrong with that action.',
          ephemeral: true,
        });
      }
    } catch {
      // already responded
    }
  }
}

/**
 * Modal submit dispatcher. Only handles the daily quiz answer modal for now.
 */
async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseDailyCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'modal') {
    await interaction.reply({
      content: '⚠️ Unknown modal submission.',
      ephemeral: true,
    });
    return;
  }

  const { date, deck } = parsed;
  const userId = interaction.user.id;
  const guess = interaction.fields.getTextInputValue(DAILY_MODAL_INPUT).trim();

  try {
    const puzzle = await getOrCreateDailyPuzzle(date, deck);
    const play = getUserPlay(userId, date, deck);
    if (!puzzle || !play) {
      await interaction.reply({
        content: '⚠️ No active daily quiz for you. Run `/quiz daily` to start.',
        ephemeral: true,
      });
      return;
    }
    if (play.completed) {
      await interaction.reply({
        content: '⚠️ Today\'s game is already finished.',
        ephemeral: true,
      });
      return;
    }

    const card = puzzle.cards[play.currentQuestion];
    if (!card) {
      await interaction.reply({
        content: '⚠️ Out of questions — finishing up.',
        ephemeral: true,
      });
      return;
    }

    const correct = isCorrectAnswer(guess, card.back);
    let updatedPlay = recordGuess(userId, date, deck, guess, correct);
    if (!updatedPlay) {
      await interaction.reply({ content: '❌ Failed to record guess.', ephemeral: true });
      return;
    }

    const isLast = updatedPlay.currentQuestion >= DAILY_QUESTION_COUNT;
    if (isLast) {
      updatedPlay = markCompleted(userId, date, deck) ?? updatedPlay;
    }
    const payload = isLast
      ? buildDailyResultMessage(updatedPlay, puzzle, interaction.user.username)
      : buildDailyGameMessage(updatedPlay, puzzle);

    // Edit the ephemeral message the Guess button lived on. Only available
    // when the modal was launched from a message component (which it was —
    // we showed it from a button). Falls back to a fresh ephemeral reply.
    if (interaction.isFromMessage()) {
      await interaction.update(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (error) {
    logger.error('Daily quiz modal submit error:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Failed to record your guess.',
          ephemeral: true,
        });
      }
    } catch {
      // already responded
    }
  }
}

/**
 * Handle ask-question capability responses
 * When user clicks button or selects option from an ask-question prompt
 */
async function handleAskQuestionResponse(interaction: ButtonInteraction | SelectMenuInteraction) {
  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);

  try {
    // Extract the answer
    let answer: string | string[];
    let answerLabel: string;

    if (interaction.isButton()) {
      // Button: extract value from customId (format: ask_timestamp_value)
      const parts = interaction.customId.split('_');
      answer = parts.slice(2).join('_'); // Everything after "ask_timestamp"
      answerLabel = (interaction.component as any)?.label || answer;
    } else if (interaction.isStringSelectMenu()) {
      // Select menu: can have multiple values
      answer = interaction.values;
      answerLabel = interaction.values
        .map((val) => {
          const opt = interaction.component?.options?.find((o) => o.value === val);
          return opt?.label || val;
        })
        .join(', ');
    } else {
      throw new Error('Unsupported interaction type for ask-question');
    }

    logger.info(`Question answered [${shortId}]:`, {
      correlationId,
      userId: interaction.user.id,
      customId: interaction.customId,
      answer,
      answerLabel,
    });

    // Acknowledge the interaction
    await interaction.reply({
      content: `✅ You selected: **${answerLabel}**`,
      ephemeral: true,
    });

    telemetry.logEvent(
      'ask_question_answered',
      {
        customId: interaction.customId,
        answer: Array.isArray(answer) ? answer.join(',') : answer,
      },
      correlationId,
      interaction.user.id
    );

    // TODO: Store the answer in a way that the capability orchestrator can retrieve it
    // For now, this just acknowledges the response
    // Future: Use Redis to store answer with customId as key
  } catch (error) {
    logger.error(`Failed to handle ask-question response [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      customId: interaction.customId,
    });

    try {
      if (!interaction.replied) {
        await interaction.reply({
          content: `❌ Failed to process your selection [${shortId}]`,
          ephemeral: true,
        });
      }
    } catch (replyError) {
      logger.error('Failed to send error reply:', replyError);
    }
  }
}

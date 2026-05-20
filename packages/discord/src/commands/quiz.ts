import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  InteractionResponse,
  Channel,
  PermissionsBitField,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { quizSessionManager, QuizSession } from '../services/quiz-session-manager.js';
import { buildLiveQuizMessage, buildQuizSummary } from '../services/quiz-embed.js';
import {
  ensureDailyQuizTables,
  fetchUniqueCards,
  getDeckPoll,
  getDeckVoteTallies,
  getGuildConfig,
  getOrCreateDailyPuzzle,
  getOrCreateDeckPoll,
  getMostRecentCompletedPlay,
  getServerLeaderboard,
  getUserPlay,
  isDeckAllowedForGuild,
  KNOWN_DECKS,
  attachPollMessage,
  ACHIEVEMENTS,
  computeAchievements,
  computeUserStats,
  setGuildAllowedDecks,
  setGuildDefaultDeck,
  startUserPlay,
  todayKey,
  tomorrowKey,
  DAILY_QUESTION_COUNT,
  type LeaderboardScope,
} from '../services/daily-quiz.js';
import {
  buildChallengeMessage,
  buildDailyGameMessage,
  buildDailyResultMessage,
  buildDeckVoteMessage,
  buildGuildConfigEmbed,
  buildLeaderboardMessage,
  buildProfileMessage,
  buildScheduleDraftMessage,
} from '../services/daily-quiz-embed.js';

const DECK_CHOICES = [
  { name: 'All Decks (Random)', value: 'all' },
  { name: 'Computers', value: 'COMPUTERS' },
  { name: 'Electrical & Radio', value: 'ELECTRICAL_AND_RADIO' },
  { name: 'Politics', value: 'POLITICS' },
  { name: "Rubik's 2x2", value: 'RUBIKS_2x2' },
  { name: 'Search & Rescue', value: 'SAR_AND_WILDERNESS' },
];

const SCHEDULE_DRAFTS = new Map<string, import('../services/quiz-session-manager.js').FlashcardResponse[]>();
const draftKey = (userId: string, guildId: string, date: string, deck: string) =>
  `${userId}:${guildId}:${date}:${deck}`;
export function getScheduleDraft(
  userId: string,
  guildId: string,
  date: string,
  deck: string
): import('../services/quiz-session-manager.js').FlashcardResponse[] | undefined {
  return SCHEDULE_DRAFTS.get(draftKey(userId, guildId, date, deck));
}
export function setScheduleDraft(
  userId: string,
  guildId: string,
  date: string,
  deck: string,
  cards: import('../services/quiz-session-manager.js').FlashcardResponse[]
): void {
  SCHEDULE_DRAFTS.set(draftKey(userId, guildId, date, deck), cards);
}
export function clearScheduleDraft(
  userId: string,
  guildId: string,
  date: string,
  deck: string
): void {
  SCHEDULE_DRAFTS.delete(draftKey(userId, guildId, date, deck));
}

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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('schedule')
        .setDescription("(Admin) Hand-pick tomorrow's daily quiz cards for this server")
        .addStringOption((option) =>
          option
            .setName('deck')
            .setDescription('Deck to pull candidate cards from')
            .setRequired(false)
            .addChoices(...DECK_CHOICES)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('vote')
        .setDescription("(Admin) Open a poll: members vote for tomorrow's deck")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('me')
        .setDescription('Show your (or another player\'s) daily-quiz profile')
        .addUserOption((option) =>
          option.setName('user').setDescription('Whose profile to view').setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('challenge')
        .setDescription('Challenge a friend to beat your daily quiz score')
        .addUserOption((option) =>
          option.setName('user').setDescription('Who to challenge').setRequired(true)
        )
        .addStringOption((option) =>
          option.setName('note').setDescription('Optional trash talk').setRequired(false)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('config')
        .setDescription('(Admin) Per-server quiz settings')
        .addSubcommand((subcommand) =>
          subcommand.setName('show').setDescription("Show this server's quiz config")
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('allow-decks')
            .setDescription('Set the allow-list of decks (empty = all). Comma-separated.')
            .addStringOption((option) =>
              option
                .setName('decks')
                .setDescription('e.g. POLITICS,COMPUTERS — leave blank to allow all')
                .setRequired(false)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('default-deck')
            .setDescription('Set the default deck for /quiz daily (clears if omitted)')
            .addStringOption((option) =>
              option
                .setName('deck')
                .setDescription('Deck id')
                .setRequired(false)
                .addChoices(...DECK_CHOICES)
            )
        )
    ),

  async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<InteractionResponse<boolean> | undefined> {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (group === 'config') {
        return await handleConfig(interaction, subcommand);
      }
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
        case 'schedule':
          return await handleSchedule(interaction);
        case 'vote':
          return await handleVote(interaction);
        case 'me':
          return await handleMe(interaction);
        case 'challenge':
          return await handleChallenge(interaction);
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
  let deck: string;
  if (deckOption === null && interaction.guildId) {
    // No explicit pick → fall back to the guild's configured default.
    const cfg = getGuildConfig(interaction.guildId);
    deck = cfg.defaultDeck ?? '';
  } else {
    deck = deckOption && deckOption !== 'all' ? deckOption : '';
  }

  if (interaction.guildId && !isDeckAllowedForGuild(interaction.guildId, deck)) {
    const cfg = getGuildConfig(interaction.guildId);
    return await interaction.reply({
      content: `❌ The **${deck || 'All Decks'}** deck isn't enabled on this server.\nAllowed: ${cfg.allowedDecks.map((d) => `\`${d || 'all'}\``).join(', ')}`,
      ephemeral: true,
    });
  }

  const date = todayKey();

  await interaction.deferReply({ ephemeral: true });
  ensureDailyQuizTables();

  let puzzle;
  try {
    puzzle = await getOrCreateDailyPuzzle(date, deck, interaction.guildId);
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

function ensureAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guildId) return false;
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return perms.has(PermissionsBitField.Flags.ManageGuild);
}

/**
 * Admin: pre-pick tomorrow's daily puzzle. Ephemeral preview with shuffle /
 * use / cancel buttons.
 */
async function handleSchedule(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  if (!interaction.guildId) {
    return await interaction.reply({
      content: '⚠️ Run this in a server channel.',
      ephemeral: true,
    });
  }
  if (!ensureAdmin(interaction)) {
    return await interaction.reply({
      content: '🚫 Need **Manage Server** permission to schedule daily quizzes.',
      ephemeral: true,
    });
  }

  const deckOption = interaction.options.getString('deck');
  const deck = deckOption && deckOption !== 'all' ? deckOption : '';
  const date = tomorrowKey();

  if (!isDeckAllowedForGuild(interaction.guildId, deck)) {
    return await interaction.reply({
      content: `❌ That deck isn't in this server's allow-list. See \`/quiz config show\`.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });
  ensureDailyQuizTables();

  let cards: import('../services/quiz-session-manager.js').FlashcardResponse[] = [];
  try {
    cards = await fetchUniqueCards(deck, DAILY_QUESTION_COUNT);
  } catch (e) {
    logger.error('Schedule preview fetch failed:', e);
  }

  setScheduleDraft(interaction.user.id, interaction.guildId, date, deck, cards);
  const payload = buildScheduleDraftMessage(date, deck, cards);
  await interaction.editReply(payload);
  return undefined;
}

/**
 * Admin: per-server quiz config (allow-list, default deck).
 */
async function handleConfig(
  interaction: ChatInputCommandInteraction,
  subcommand: string
): Promise<InteractionResponse<boolean> | undefined> {
  if (!interaction.guildId) {
    return await interaction.reply({
      content: '⚠️ Run this in a server channel.',
      ephemeral: true,
    });
  }

  if (subcommand !== 'show' && !ensureAdmin(interaction)) {
    return await interaction.reply({
      content: '🚫 Need **Manage Server** permission to change quiz config.',
      ephemeral: true,
    });
  }

  ensureDailyQuizTables();
  const guildName = interaction.guild?.name || 'This server';

  if (subcommand === 'show') {
    const cfg = getGuildConfig(interaction.guildId);
    return await interaction.reply({ ...buildGuildConfigEmbed(cfg, guildName), ephemeral: true });
  }

  if (subcommand === 'allow-decks') {
    const raw = interaction.options.getString('decks') || '';
    // Parse comma-separated deck IDs; "all" is the empty-deck sentinel.
    const tokens = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.toLowerCase() === 'all' ? '' : s.toUpperCase()));
    const unknown = tokens.filter((t) => !KNOWN_DECKS.includes(t as any));
    if (unknown.length > 0) {
      return await interaction.reply({
        content: `❌ Unknown deck(s): ${unknown.map((u) => `\`${u}\``).join(', ')}\nKnown: ${KNOWN_DECKS.map((d) => d || 'all').join(', ')}`,
        ephemeral: true,
      });
    }
    const cfg = setGuildAllowedDecks(interaction.guildId, tokens);
    return await interaction.reply({ ...buildGuildConfigEmbed(cfg, guildName), ephemeral: true });
  }

  if (subcommand === 'default-deck') {
    const deckOption = interaction.options.getString('deck');
    const deck = deckOption === null ? null : deckOption === 'all' ? '' : deckOption;
    const cfg = setGuildDefaultDeck(interaction.guildId, deck);
    return await interaction.reply({ ...buildGuildConfigEmbed(cfg, guildName), ephemeral: true });
  }

  return await interaction.reply({ content: 'Unknown config subcommand', ephemeral: true });
}

/**
 * Compute the ballot for a guild's deck vote. Prefer the guild's allow-list;
 * fall back to all named decks. Excludes the '' "all decks" sentinel because
 * picking "all" defeats the point of voting on a deck.
 */
export function getBallotDecks(guildId: string): string[] {
  const cfg = getGuildConfig(guildId);
  const candidates = cfg.allowedDecks.length > 0 ? cfg.allowedDecks : (KNOWN_DECKS as readonly string[]);
  return candidates.filter((d) => d !== '');
}

/**
 * Admin: open a deck vote for tomorrow. Posts a public embed in the channel.
 */
async function handleVote(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  if (!interaction.guildId) {
    return await interaction.reply({
      content: '⚠️ Run this in a server channel.',
      ephemeral: true,
    });
  }
  if (!ensureAdmin(interaction)) {
    return await interaction.reply({
      content: '🚫 Need **Manage Server** permission to start a vote.',
      ephemeral: true,
    });
  }

  ensureDailyQuizTables();
  const date = tomorrowKey();
  const ballot = getBallotDecks(interaction.guildId);
  if (ballot.length === 0) {
    return await interaction.reply({
      content: '⚠️ No decks available to vote on. Add some with `/quiz config allow-decks`.',
      ephemeral: true,
    });
  }

  const existing = getDeckPoll(interaction.guildId, date);
  if (existing && existing.status === 'closed') {
    return await interaction.reply({
      content: `⚠️ Tomorrow's vote is already closed (winner: **${existing.winningDeck || 'none'}**). Try again tomorrow.`,
      ephemeral: true,
    });
  }

  const poll = getOrCreateDeckPoll(interaction.guildId, date, interaction.user.id);
  const tallies = getDeckVoteTallies(poll.id, ballot);
  const payload = buildDeckVoteMessage(poll, tallies);

  // Reply publicly so members can vote, then record the message id so the
  // button handlers know which message to edit.
  const sent = await interaction.reply({ ...payload, fetchReply: true });
  attachPollMessage(poll.id, interaction.channelId, sent.id);
  return undefined;
}

/**
 * Public profile card — flexes lifetime stats + badges. Designed to be
 * screenshotted and shared elsewhere ("oh, what bot is that?").
 */
async function handleMe(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  ensureDailyQuizTables();
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const stats = computeUserStats(targetUser.id, interaction.guildId);
  const earned = ACHIEVEMENTS.filter((a) => computeAchievements(stats).has(a.id));
  const payload = buildProfileMessage(targetUser, stats, earned);
  return await interaction.reply(payload);
}

/**
 * Tag a friend with a "beat my score" public callout. The caller's most
 * recent completed play (any deck) is included so the target sees what
 * they're up against.
 */
async function handleChallenge(
  interaction: ChatInputCommandInteraction
): Promise<InteractionResponse<boolean> | undefined> {
  const target = interaction.options.getUser('user', true);
  if (target.id === interaction.user.id) {
    return await interaction.reply({
      content: '⚠️ You can\'t challenge yourself!',
      ephemeral: true,
    });
  }
  if (target.bot) {
    return await interaction.reply({
      content: '⚠️ Bots don\'t play the daily quiz.',
      ephemeral: true,
    });
  }
  const note = interaction.options.getString('note') || undefined;
  const recentPlay = getMostRecentCompletedPlay(interaction.user.id, interaction.guildId);
  const payload = buildChallengeMessage(
    interaction.user,
    target,
    recentPlay,
    todayKey(),
    note
  );
  return await interaction.reply(payload);
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

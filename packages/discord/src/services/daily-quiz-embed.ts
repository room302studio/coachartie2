/**
 * UI builders for the async daily quiz — solo Wordle-style game.
 *
 * Encoded customId scheme so we can route interactions without per-user state
 * in memory:
 *   quiz:daily:guess:<date>:<deck>    button → opens guess modal
 *   quiz:daily:modal:<date>:<deck>    modal submit
 *   quiz:daily:share:<date>:<deck>    button → posts public share card
 *   quiz:daily:replay:<date>:<deck>   button (post-share) → no-op informational
 *
 * <deck> is the literal deck id or the string "all".
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  DAILY_QUESTION_COUNT,
  renderEmojiGrid,
  type DailyPlay,
  type DailyPuzzle,
  type DeckPoll,
  type DeckTally,
  type GuildQuizConfig,
  type LeaderboardScope,
  type ServerLeaderboardRow,
} from './daily-quiz.js';
import type { FlashcardResponse } from './quiz-session-manager.js';

export const DAILY_PREFIX = 'quiz:daily:';
export const DAILY_MODAL_INPUT = 'answer';
export const SCHEDULE_PREFIX = 'quiz:schedule:';
export const VOTE_PREFIX = 'quiz:vote:';

export type DailyAction = 'guess' | 'modal' | 'share' | 'replay';
export type ScheduleAction = 'shuffle' | 'save' | 'cancel';
export type VoteAction = 'cast' | 'close';

export function dailyCustomId(action: DailyAction, date: string, deck: string): string {
  return `${DAILY_PREFIX}${action}:${date}:${deck || 'all'}`;
}

export interface ParsedDailyId {
  action: DailyAction;
  date: string;
  deck: string; // "" means all decks
}

export function parseDailyCustomId(customId: string): ParsedDailyId | null {
  if (!customId.startsWith(DAILY_PREFIX)) return null;
  const rest = customId.slice(DAILY_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length < 3) return null;
  const [action, date, ...deckParts] = parts;
  if (action !== 'guess' && action !== 'modal' && action !== 'share' && action !== 'replay') {
    return null;
  }
  const deckRaw = deckParts.join(':');
  return { action, date, deck: deckRaw === 'all' ? '' : deckRaw };
}

function deckLabel(deck: string): string {
  return deck || 'All Decks';
}

/**
 * Ephemeral embed shown while the user is mid-game. Re-rendered after each
 * guess so the progress grid grows in place.
 */
export function buildDailyGameMessage(play: DailyPlay, puzzle: DailyPuzzle): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const grid = renderEmojiGrid(play.results, DAILY_QUESTION_COUNT);
  const card = puzzle.cards[play.currentQuestion];

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎓 Daily Quiz · ${deckLabel(puzzle.deck)}`)
    .setDescription(
      [
        grid,
        `_Question ${Math.min(play.currentQuestion + 1, DAILY_QUESTION_COUNT)} of ${DAILY_QUESTION_COUNT} · ${play.date}_`,
      ].join('\n')
    );

  if (card) {
    embed.addFields({
      name: `❓ Question ${play.currentQuestion + 1}`,
      value: card.front.length > 1000 ? card.front.slice(0, 997) + '…' : card.front,
    });
    if (card.hints.length > 0) {
      embed.setFooter({
        text: `💡 ${card.hints.length} hint(s) — they'll show after you submit a guess`,
      });
    }
  }

  if (play.results.length > 0) {
    const lastIdx = play.results.length - 1;
    const lastCard = puzzle.cards[lastIdx];
    if (lastCard) {
      embed.addFields({
        name: play.results[lastIdx] === 'correct' ? '✅ Last answer' : '❌ Last answer',
        value: `You said: _${play.guesses[lastIdx] || '(empty)'}_\nCorrect: **${lastCard.back}**`,
      });
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(dailyCustomId('guess', play.date, play.deck))
      .setLabel('Guess')
      .setEmoji('⌨️')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Ephemeral embed after the user finishes all questions. Offers a Share
 * button — clicking it posts the public card.
 */
export function buildDailyResultMessage(
  play: DailyPlay,
  puzzle: DailyPuzzle,
  username: string
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const grid = renderEmojiGrid(play.results, DAILY_QUESTION_COUNT);
  const score = play.results.filter((o) => o === 'correct').length;

  const embed = new EmbedBuilder()
    .setColor(score === DAILY_QUESTION_COUNT ? 0x57f287 : 0xfee75c)
    .setTitle(`🏁 Daily Quiz · ${deckLabel(puzzle.deck)} · ${play.date}`)
    .setDescription([grid, `**${score} / ${DAILY_QUESTION_COUNT}** correct`].join('\n'))
    .addFields({
      name: '🔎 Answer key',
      value: puzzle.cards
        .map((card, i) => {
          const mark = play.results[i] === 'correct' ? '🟩' : '🟥';
          const yourGuess = play.guesses[i] || '(empty)';
          return `${mark} **${card.back}** — _you said: ${yourGuess}_`;
        })
        .join('\n')
        .slice(0, 1024),
    })
    .setFooter({
      text: play.shared
        ? `Shared by ${username}`
        : `Tap Share to post your result in the channel`,
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(dailyCustomId('share', play.date, play.deck))
      .setLabel(play.shared ? 'Shared ✓' : 'Share to channel')
      .setEmoji(play.shared ? '✅' : '📣')
      .setStyle(play.shared ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(play.shared)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Public share card — what everyone in the channel sees. Mirrors the
 * Wordle "share your result" block.
 */
export function buildDailyShareMessage(
  play: DailyPlay,
  username: string
): { embeds: EmbedBuilder[] } {
  const grid = renderEmojiGrid(play.results, DAILY_QUESTION_COUNT);
  const score = play.results.filter((o) => o === 'correct').length;

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`🎓 Daily Quiz · ${play.deck || 'All Decks'} · ${play.date}`)
    .setDescription([`**${username}** — **${score}/${DAILY_QUESTION_COUNT}**`, grid].join('\n'))
    .setFooter({ text: 'Try it: /quiz daily' });

  return { embeds: [embed] };
}

export function scheduleCustomId(action: ScheduleAction, date: string, deck: string): string {
  return `${SCHEDULE_PREFIX}${action}:${date}:${deck || 'all'}`;
}

export interface ParsedScheduleId {
  action: ScheduleAction;
  date: string;
  deck: string;
}

export function parseScheduleCustomId(customId: string): ParsedScheduleId | null {
  if (!customId.startsWith(SCHEDULE_PREFIX)) return null;
  const rest = customId.slice(SCHEDULE_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length < 3) return null;
  const [action, date, ...deckParts] = parts;
  if (action !== 'shuffle' && action !== 'save' && action !== 'cancel') return null;
  const deckRaw = deckParts.join(':');
  return { action, date, deck: deckRaw === 'all' ? '' : deckRaw };
}

/**
 * Admin schedule-preview card. Shows the proposed 5 cards for tomorrow with
 * Shuffle / Use these / Cancel buttons. Lives in an ephemeral message.
 */
export function buildScheduleDraftMessage(
  date: string,
  deck: string,
  cards: FlashcardResponse[],
  options: { saved?: boolean; cancelled?: boolean } = {}
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const status = options.saved
    ? '✅ Saved as tomorrow\'s puzzle.'
    : options.cancelled
      ? '❌ Cancelled.'
      : '🪄 Preview — these are the cards your members will see.';

  const embed = new EmbedBuilder()
    .setColor(options.saved ? 0x57f287 : options.cancelled ? 0xed4245 : 0x5865f2)
    .setTitle(`🗓️ Schedule Daily Quiz · ${date} · ${deck || 'All Decks'}`)
    .setDescription(status);

  if (cards.length > 0) {
    embed.addFields({
      name: `Cards (${cards.length})`,
      value: cards
        .map((c, i) => {
          const front = c.front.length > 80 ? c.front.slice(0, 77) + '…' : c.front;
          return `**${i + 1}.** ${front}\n   → _${c.back}_`;
        })
        .join('\n'),
    });
  } else {
    embed.addFields({
      name: 'No cards',
      value: '_The API didn\'t hand back any cards for this deck — try again._',
    });
  }

  if (options.saved || options.cancelled) {
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(scheduleCustomId('shuffle', date, deck))
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cards.length === 0),
    new ButtonBuilder()
      .setCustomId(scheduleCustomId('save', date, deck))
      .setLabel('Use these')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(cards.length === 0),
    new ButtonBuilder()
      .setCustomId(scheduleCustomId('cancel', date, deck))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Per-server config readout. Shows allowed decks + default.
 */
export function buildGuildConfigEmbed(
  config: GuildQuizConfig,
  guildName: string
): { embeds: EmbedBuilder[] } {
  const allowed =
    config.allowedDecks.length === 0
      ? '_All decks (no restriction)_'
      : config.allowedDecks
          .map((d) => `• ${d === '' ? 'All Decks (Random)' : d}`)
          .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚙️ Daily Quiz Config · ${guildName}`)
    .addFields(
      { name: 'Allowed Decks', value: allowed, inline: false },
      {
        name: 'Default Deck',
        value: config.defaultDeck === null
          ? '_None_'
          : config.defaultDeck === ''
            ? 'All Decks (Random)'
            : config.defaultDeck,
        inline: false,
      }
    )
    .setFooter({ text: 'Use /quiz config decks set ... to change' });
  return { embeds: [embed] };
}

// ---------------------------------------------------------------------------
// Deck vote (group picks tomorrow's deck).
// ---------------------------------------------------------------------------

/**
 * Encoded as `quiz:vote:cast:<pollId>:<deck>` and `quiz:vote:close:<pollId>`.
 * pollId is the autoincrement id from daily_quiz_deck_polls so we don't have
 * to plumb guild/date through every interaction.
 */
export function voteCustomId(action: VoteAction, pollId: number, deck?: string): string {
  if (action === 'cast') {
    return `${VOTE_PREFIX}cast:${pollId}:${deck === '' ? 'all' : deck}`;
  }
  return `${VOTE_PREFIX}close:${pollId}`;
}

export interface ParsedVoteId {
  action: VoteAction;
  pollId: number;
  deck: string; // '' for the "all decks" sentinel; '' on close-action too
}

export function parseVoteCustomId(customId: string): ParsedVoteId | null {
  if (!customId.startsWith(VOTE_PREFIX)) return null;
  const rest = customId.slice(VOTE_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length < 2) return null;
  const action = parts[0];
  const pollId = Number(parts[1]);
  if (!Number.isFinite(pollId)) return null;
  if (action === 'close') return { action: 'close', pollId, deck: '' };
  if (action === 'cast' && parts.length >= 3) {
    const deckRaw = parts.slice(2).join(':');
    return { action: 'cast', pollId, deck: deckRaw === 'all' ? '' : deckRaw };
  }
  return null;
}

function deckButtonLabel(deck: string): string {
  return deck === '' ? 'All Decks' : deck.replace(/_/g, ' ');
}

function renderTallyBar(votes: number, max: number): string {
  if (max === 0) return '░░░░░░';
  const filled = Math.round((votes / max) * 6);
  return '█'.repeat(filled) + '░'.repeat(6 - filled);
}

/**
 * Live vote embed (open) or final-tally embed (closed). The closed variant
 * also reports the winning deck and that cards have been scheduled.
 */
export function buildDeckVoteMessage(
  poll: DeckPoll,
  tallies: DeckTally[],
  options: { winningDeck?: string | null; scheduledOk?: boolean } = {}
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const isClosed = poll.status === 'closed';
  const maxVotes = Math.max(0, ...tallies.map((t) => t.votes));
  const totalVotes = tallies.reduce((sum, t) => sum + t.votes, 0);

  const lines = tallies.map((t) => {
    const bar = renderTallyBar(t.votes, maxVotes);
    const label = deckButtonLabel(t.deck);
    const marker = isClosed && t.deck === options.winningDeck ? '🏆 ' : '';
    return `${marker}**${label}** ${bar} ${t.votes}`;
  });

  const description = [
    isClosed
      ? `🔒 Voting closed — picking tomorrow's deck.`
      : `One vote each — change anytime. Admin can close when ready.`,
    '',
    ...lines,
    '',
    `_${totalVotes} vote${totalVotes === 1 ? '' : 's'} cast_`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(isClosed ? 0xfee75c : 0x5865f2)
    .setTitle(`🗳️ Vote · Tomorrow's Deck · ${poll.targetDate}`)
    .setDescription(description);

  if (isClosed) {
    if (options.winningDeck) {
      embed.addFields({
        name: '🏆 Winner',
        value: `**${deckButtonLabel(options.winningDeck)}** — ${
          options.scheduledOk
            ? `cards scheduled for ${poll.targetDate}. Run \`/quiz daily\` tomorrow to play.`
            : '⚠️ Could not fetch cards; admin may need to `/quiz schedule` manually.'
        }`,
      });
    } else {
      embed.addFields({
        name: '🤷 No winner',
        value: 'No votes were cast. Tomorrow\'s daily will be a random pull.',
      });
    }
    return { embeds: [embed], components: [] };
  }

  // Open poll: render one row of deck buttons + a separate row with the
  // Close button. Discord caps an action row at 5 components so we slice.
  const buttons = tallies.slice(0, 5).map((t) =>
    new ButtonBuilder()
      .setCustomId(voteCustomId('cast', poll.id, t.deck))
      .setLabel(deckButtonLabel(t.deck))
      .setStyle(ButtonStyle.Primary)
  );
  const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(voteCustomId('close', poll.id))
      .setLabel('Close vote')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [voteRow, closeRow] };
}

const SCOPE_LABEL: Record<LeaderboardScope, string> = {
  today: "Today's Daily",
  week: 'This Week',
  alltime: 'All-Time',
};

/**
 * Server leaderboard card. Mirrors the share grid's visual style and surfaces
 * the three Wordle-style metrics: total correct, perfect days (Wordles),
 * current streak.
 */
export function buildLeaderboardMessage(
  rows: ServerLeaderboardRow[],
  scope: LeaderboardScope,
  guildName: string
): { embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`🏆 ${guildName} · Daily Quiz Leaderboard`)
    .setFooter({ text: `${SCOPE_LABEL[scope]} · ranked by total correct, then perfect days` });

  if (rows.length === 0) {
    embed.setDescription(
      '_No completed daily quizzes yet — be the first with `/quiz daily`!_'
    );
    return { embeds: [embed] };
  }

  const lines = rows.map((row, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const perfect = row.perfectDays > 0 ? ` · ⭐${row.perfectDays}` : '';
    const streak = row.currentStreak >= 2 ? ` · 🔥${row.currentStreak}` : '';
    return `${medal} <@${row.userId}> — **${row.totalCorrect}** pts across ${row.plays} day${row.plays === 1 ? '' : 's'}${perfect}${streak}`;
  });

  embed.setDescription(lines.join('\n'));
  return { embeds: [embed] };
}

/**
 * Modal that pops up when the user clicks Guess. Single text input, length
 * capped so we don't accept a novel.
 */
export function buildGuessModal(date: string, deck: string, questionNumber: number): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(dailyCustomId('modal', date, deck))
    .setTitle(`Daily Quiz · Question ${questionNumber}`);

  const input = new TextInputBuilder()
    .setCustomId(DAILY_MODAL_INPUT)
    .setLabel('Your answer')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(200)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

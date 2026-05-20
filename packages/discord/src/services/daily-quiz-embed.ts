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
  type LeaderboardScope,
  type ServerLeaderboardRow,
} from './daily-quiz.js';

export const DAILY_PREFIX = 'quiz:daily:';
export const DAILY_MODAL_INPUT = 'answer';

export type DailyAction = 'guess' | 'modal' | 'share' | 'replay';

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

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
  type Achievement,
  type DailyPlay,
  type DailyPuzzle,
  type DeckPoll,
  type DeckTally,
  type GuildQuizConfig,
  type LeaderboardScope,
  type ServerLeaderboardRow,
  type UserStats,
} from './daily.js';
import type { FlashcardResponse } from './live-session.js';

const DAILY_PREFIX = 'quiz:daily:';
export const DAILY_MODAL_INPUT = 'answer';
const SCHEDULE_PREFIX = 'quiz:schedule:';
const VOTE_PREFIX = 'quiz:vote:';

type DailyAction = 'guess' | 'modal' | 'share' | 'replay';
type ScheduleAction = 'shuffle' | 'save' | 'cancel';
type VoteAction = 'cast' | 'close';

export function dailyCustomId(action: DailyAction, date: string, deck: string): string {
  return `${DAILY_PREFIX}${action}:${date}:${deck || 'all'}`;
}

interface ParsedDailyId {
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
  let deck: string;
  if (deckRaw === 'all') {
    deck = '';
  } else {
    deck = deckRaw;
  }
  return { action, date, deck };
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
    let frontText: string;
    if (card.front.length > 1000) {
      frontText = card.front.slice(0, 997) + '…';
    } else {
      frontText = card.front;
    }
    embed.addFields({
      name: `❓ Question ${play.currentQuestion + 1}`,
      value: frontText,
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
      let lastAnswerName: string;
      if (play.results[lastIdx] === 'correct') {
        lastAnswerName = '✅ Last answer';
      } else {
        lastAnswerName = '❌ Last answer';
      }
      embed.addFields({
        name: lastAnswerName,
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

  function scoreColor(score: number, total: number): number {
    if (score === total) {
      return 0x57f287;
    }
    return 0xfee75c;
  }

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score, DAILY_QUESTION_COUNT))
    .setTitle(`🏁 Daily Quiz · ${deckLabel(puzzle.deck)} · ${play.date}`)
    .setDescription([grid, `**${score} / ${DAILY_QUESTION_COUNT}** correct`].join('\n'))
    .addFields({
      name: '🔎 Answer key',
      value: puzzle.cards
        .map((card, i) => {
          function resultMark(result: string | undefined): string {
            if (result === 'correct') {
              return '🟩';
            }
            return '🟥';
          }
          const mark = resultMark(play.results[i]);
          const yourGuess = play.guesses[i] || '(empty)';
          return `${mark} **${card.back}** — _you said: ${yourGuess}_`;
        })
        .join('\n')
        .slice(0, 1024),
    });

  let footerText: string;
  if (play.shared) {
    footerText = `Shared by ${username}`;
  } else {
    footerText = `Tap Share to post your result in the channel`;
  }

  embed.setFooter({
    text: footerText,
  });

  function shareButtonLabel(): string {
    if (play.shared) {
      return 'Shared ✓';
    }
    return 'Share to channel';
  }

  function shareButtonEmoji(): string {
    if (play.shared) {
      return '✅';
    }
    return '📣';
  }

  function shareButtonStyle(): ButtonStyle {
    if (play.shared) {
      return ButtonStyle.Secondary;
    }
    return ButtonStyle.Success;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(dailyCustomId('share', play.date, play.deck))
      .setLabel(shareButtonLabel())
      .setEmoji(shareButtonEmoji())
      .setStyle(shareButtonStyle())
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

interface ParsedScheduleId {
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
  let deck: string;
  if (deckRaw === 'all') {
    deck = '';
  } else {
    deck = deckRaw;
  }
  return { action, date, deck };
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
  function scheduleStatus(): string {
    if (options.saved) {
      return '✅ Saved as tomorrow\'s puzzle.';
    }
    if (options.cancelled) {
      return '❌ Cancelled.';
    }
    return '🪄 Preview — these are the cards your members will see.';
  }

  const status = scheduleStatus();

  function scheduleEmbedColor(): number {
    if (options.saved) {
      return 0x57f287;
    }
    if (options.cancelled) {
      return 0xed4245;
    }
    return 0x5865f2;
  }

  const embed = new EmbedBuilder()
    .setColor(scheduleEmbedColor())
    .setTitle(`🗓️ Schedule Daily Quiz · ${date} · ${deck || 'All Decks'}`)
    .setDescription(status);

  if (cards.length > 0) {
    embed.addFields({
      name: `Cards (${cards.length})`,
      value: cards
        .map((c, i) => {
          function cardFrontDisplay(front: string): string {
            if (front.length > 80) {
              return front.slice(0, 77) + '…';
            }
            return front;
          }
          const front = cardFrontDisplay(c.front);
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
  function deckDisplayName(deck: string): string {
    if (deck === '') {
      return 'All Decks (Random)';
    }
    return deck;
  }

  let allowed: string;
  if (config.allowedDecks.length === 0) {
    allowed = '_All decks (no restriction)_';
  } else {
    allowed = config.allowedDecks
      .map((d) => `• ${deckDisplayName(d)}`)
      .join('\n');
  }

  let defaultDeckValue: string;
  if (config.defaultDeck === null) {
    defaultDeckValue = '_None_';
  } else if (config.defaultDeck === '') {
    defaultDeckValue = 'All Decks (Random)';
  } else {
    defaultDeckValue = config.defaultDeck;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚙️ Daily Quiz Config · ${guildName}`)
    .addFields(
      { name: 'Allowed Decks', value: allowed, inline: false },
      {
        name: 'Default Deck',
        value: defaultDeckValue,
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
    let deckPart: string | undefined;
    if (deck === '') {
      deckPart = 'all';
    } else {
      deckPart = deck;
    }
    return `${VOTE_PREFIX}cast:${pollId}:${deckPart}`;
  }
  return `${VOTE_PREFIX}close:${pollId}`;
}

interface ParsedVoteId {
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
    let deck: string;
    if (deckRaw === 'all') {
      deck = '';
    } else {
      deck = deckRaw;
    }
    return { action: 'cast', pollId, deck };
  }
  return null;
}

function deckButtonLabel(deck: string): string {
  if (deck === '') {
    return 'All Decks';
  }
  return deck.replace(/_/g, ' ');
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

  function voteMarker(deck: string): string {
    if (isClosed && deck === options.winningDeck) {
      return '🏆 ';
    }
    return '';
  }

  const lines = tallies.map((t) => {
    const bar = renderTallyBar(t.votes, maxVotes);
    const label = deckButtonLabel(t.deck);
    const marker = voteMarker(t.deck);
    return `${marker}**${label}** ${bar} ${t.votes}`;
  });

  function descriptionHeader(): string {
    if (isClosed) {
      return `🔒 Voting closed — picking tomorrow's deck.`;
    }
    return `One vote each — change anytime. Admin can close when ready.`;
  }

  function voteSuffix(): string {
    if (totalVotes === 1) {
      return '';
    }
    return 's';
  }

  const description = [
    descriptionHeader(),
    '',
    ...lines,
    '',
    `_${totalVotes} vote${voteSuffix()} cast_`,
  ].join('\n');

  function embedColor(): number {
    if (isClosed) {
      return 0xfee75c;
    }
    return 0x5865f2;
  }

  const embed = new EmbedBuilder()
    .setColor(embedColor())
    .setTitle(`🗳️ Vote · Tomorrow's Deck · ${poll.targetDate}`)
    .setDescription(description);

  if (isClosed) {
    if (options.winningDeck) {
      let statusMessage: string;
      if (options.scheduledOk) {
        statusMessage = `cards scheduled for ${poll.targetDate}. Run \`/quiz daily\` tomorrow to play.`;
      } else {
        statusMessage = '⚠️ Could not fetch cards; admin may need to `/quiz schedule` manually.';
      }
      embed.addFields({
        name: '🏆 Winner',
        value: `**${deckButtonLabel(options.winningDeck)}** — ${statusMessage}`,
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

// ---------------------------------------------------------------------------
// Growth: shareable /quiz me profile, challenge callout, achievement unlock.
// ---------------------------------------------------------------------------

function scoreEmoji(score: number, total: number): string {
  if (total === 0 || score === 0) return '🟥';
  if (score === total) return '🟩';
  return '🟨';
}

/**
 * Public profile card — designed to be screenshottable and tweeted.
 * Surfaces the metrics that compound into "I want to play this": streak,
 * perfect days, total points, and the trailing 7-day grid.
 */
export function buildProfileMessage(
  user: { id: string; username: string },
  stats: UserStats,
  earnedAchievements: Achievement[]
): { embeds: EmbedBuilder[] } {
  let winRate: number;
  if (stats.totalPlays > 0) {
    winRate = Math.round((stats.totalCorrect / (stats.totalPlays * DAILY_QUESTION_COUNT)) * 100);
  } else {
    winRate = 0;
  }

  const recentGrid = stats.recentResults
    .map((r) => scoreEmoji(r.score, r.total))
    .join(' ');
  const recentLine = recentGrid || '_No daily plays yet — run `/quiz daily` to start._';

  let badgesField: string;
  if (earnedAchievements.length > 0) {
    badgesField = earnedAchievements
      .map((a) => `${a.emoji} **${a.label}** — _${a.description}_`)
      .join('\n');
  } else {
    badgesField = '_No badges yet. Play a daily to earn your first._';
  }

  let headline: string;
  if (stats.totalPlays === 0) {
    headline = 'No plays yet — share this command with the channel to get rolling.';
  } else {
    headline = `${stats.totalCorrect} lifetime points · ${winRate}% win rate`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📈 ${user.username} · Daily Quiz Profile`)
    .setDescription(headline)
    .addFields(
      { name: 'Current Streak', value: `🔥 **${stats.currentStreak}**`, inline: true },
      { name: 'Best Streak', value: `🏔️ **${stats.bestStreak}**`, inline: true },
      { name: 'Perfect Days', value: `⭐ **${stats.perfectDays}**`, inline: true },
      { name: 'Days Played', value: `**${stats.totalPlays}**`, inline: true },
      { name: 'Last 7 Days', value: recentLine, inline: false },
      { name: 'Badges', value: badgesField, inline: false }
    )
    .setFooter({ text: `Play your own: /quiz daily · Compare: /quiz leaderboard` });

  return { embeds: [embed] };
}

/**
 * Public challenge callout. Tags the target user, optionally includes the
 * caller's most recent score as a flex/baseline to beat.
 */
export function buildChallengeMessage(
  caller: { id: string; username: string },
  target: { id: string },
  callerRecent: DailyPlay | null,
  todayDate: string,
  note?: string
): { content: string; embeds: EmbedBuilder[] } {
  let score: number | null;
  if (callerRecent) {
    score = callerRecent.results.filter((o) => o === 'correct').length;
  } else {
    score = null;
  }

  let grid: string | null;
  if (callerRecent !== null) {
    grid = renderEmojiGrid(callerRecent.results, DAILY_QUESTION_COUNT);
  } else {
    grid = null;
  }

  const lines: string[] = [];
  if (score !== null) {
    lines.push(`**${caller.username}** dropped **${score}/${DAILY_QUESTION_COUNT}**`);
    if (grid) lines.push(grid);
  } else {
    lines.push(`**${caller.username}** wants to know if you've got it.`);
  }
  lines.push('');
  lines.push(`Run \`/quiz daily\` to play today's puzzle.`);
  if (note) {
    lines.push('');
    lines.push(`_"${note}"_`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🎯 Daily Quiz Challenge · ${todayDate}`)
    .setDescription(lines.join('\n'));

  return { content: `<@${target.id}> — you've been challenged by <@${caller.id}>`, embeds: [embed] };
}

/**
 * Tiny celebration card auto-posted when a player just unlocked a badge.
 * Mentions the player so other members see the social proof.
 */
export function buildAchievementUnlockMessage(
  user: { id: string; username: string },
  unlocked: Achievement[]
): { content: string; embeds: EmbedBuilder[] } {
  if (unlocked.length === 0) {
    return { content: '', embeds: [] };
  }
  let header: string;
  if (unlocked.length === 1) {
    header = 'Achievement unlocked!';
  } else {
    header = 'Achievements unlocked!';
  }
  const lines = unlocked
    .map((a) => `${a.emoji} **${a.label}** — _${a.description}_`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`🎉 ${header}`)
    .setDescription(lines)
    .setFooter({ text: 'See your full profile: /quiz me' });

  return { content: `<@${user.id}>`, embeds: [embed] };
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
    function getMedal(position: number): string {
      if (position === 0) {
        return '🥇';
      }
      if (position === 1) {
        return '🥈';
      }
      if (position === 2) {
        return '🥉';
      }
      return `${position + 1}.`;
    }

    function getPerfectSuffix(perfectDays: number): string {
      if (perfectDays > 0) {
        return ` · ⭐${perfectDays}`;
      }
      return '';
    }

    function getStreakSuffix(streak: number): string {
      if (streak >= 2) {
        return ` · 🔥${streak}`;
      }
      return '';
    }

    function getPluralS(count: number): string {
      if (count === 1) {
        return '';
      }
      return 's';
    }

    const medal = getMedal(i);
    const perfect = getPerfectSuffix(row.perfectDays);
    const streak = getStreakSuffix(row.currentStreak);
    const plural = getPluralS(row.plays);
    return `${medal} <@${row.userId}> — **${row.totalCorrect}** pts across ${row.plays} day${plural}${perfect}${streak}`;
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

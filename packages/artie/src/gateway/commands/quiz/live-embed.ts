/**
 * Wordle-style embed + button builders for the quiz game.
 *
 * The quiz UX is a single embed that updates in place — progress bar, current
 * question, scoreboard, and a row of action buttons (Hint / Skip / End).
 * End-of-quiz replaces it with a shareable result card.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { renderProgressBar, type QuizSession } from './live-session.js';

export const QUIZ_BUTTON_PREFIX = 'quiz:';

export type QuizButtonAction = 'hint' | 'skip' | 'end' | 'again';

export function quizButtonId(action: QuizButtonAction): string {
  return `${QUIZ_BUTTON_PREFIX}${action}`;
}

export function parseQuizButtonId(customId: string): QuizButtonAction | null {
  if (!customId.startsWith(QUIZ_BUTTON_PREFIX)) return null;
  const action = customId.slice(QUIZ_BUTTON_PREFIX.length) as QuizButtonAction;
  if (action === 'hint' || action === 'skip' || action === 'end' || action === 'again') {
    return action;
  }
  return null;
}

/**
 * Format the scoreboard as a stacked block (one user per line) — easier to
 * read in a Wordle-style embed than the single-line " | " separator.
 */
function formatScoreboard(session: QuizSession): string {
  if (session.scores.size === 0) {
    return '_No scores yet — first correct answer wins the point!_';
  }
  const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
  return sorted
    .map(([userId, score], i) => {
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
        return '▫️';
      }

      function getStreakBadge(streak: number): string {
        if (streak >= 2) {
          return ` · 🔥${streak}`;
        }
        return '';
      }

      const medal = getMedal(i);
      const streak = session.streaks.get(userId) || 0;
      const streakBadge = getStreakBadge(streak);
      return `${medal} <@${userId}> — **${score}**${streakBadge}`;
    })
    .join('\n');
}

/**
 * Build the live quiz embed + action row. Render this on /quiz start and on
 * every state change (correct answer, skip, hint, timeout) so the host
 * message can be edited in place.
 */
export function buildLiveQuizMessage(session: QuizSession): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const card = session.currentCard;
  const progressBar = renderProgressBar(session.progress);
  const deckLabel = session.deckId || 'All Decks';

  function judgeLabel(): string {
    if (session.aiJudge) {
      return ' · 🤖 AI Judge';
    }
    return '';
  }

  function embedColor(): number {
    if (session.lastBanner?.startsWith('✅')) {
      return 0x57f287;
    }
    return 0x5865f2;
  }

  function bannerLine(): string | null {
    if (session.lastBanner) {
      return `${session.lastBanner}\n`;
    }
    return null;
  }

  const embed = new EmbedBuilder()
    .setColor(embedColor())
    .setTitle(`🎮 Quiz · ${deckLabel}${judgeLabel()}`)
    .setDescription(
      [
        bannerLine(),
        progressBar,
        `_Question ${session.questionNumber} of ${session.totalQuestions}_`,
      ]
        .filter(Boolean)
        .join('\n')
    );

  function cardFrontText(c: typeof card): string {
    if (c && c.front.length > 1000) {
      return c.front.slice(0, 997) + '…';
    }
    if (c) {
      return c.front;
    }
    return '';
  }

  if (card) {
    embed.addFields({
      name: `❓ Question ${session.questionNumber}`,
      value: cardFrontText(card),
    });

    if (session.hintsRevealed > 0) {
      const revealed = card.hints.slice(0, session.hintsRevealed);
      embed.addFields({
        name: `💡 Hints (${session.hintsRevealed}/${card.hints.length})`,
        value: revealed.map((h, i) => `${i + 1}. ${h}`).join('\n'),
      });
    } else if (card.hints.length > 0) {
      embed.setFooter({ text: `💡 ${card.hints.length} hint(s) available — tap Hint` });
    }
  }

  embed.addFields({
    name: '📊 Scoreboard',
    value: formatScoreboard(session),
  });

  const hintsLeft = card ? card.hints.length - session.hintsRevealed : 0;

  function hintCountDisplay(): string {
    if (hintsLeft > 0) {
      return ` (${hintsLeft})`;
    }
    return '';
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(quizButtonId('hint'))
      .setLabel(`Hint${hintCountDisplay()}`)
      .setEmoji('💡')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(hintsLeft <= 0 || session.answered),
    new ButtonBuilder()
      .setCustomId(quizButtonId('skip'))
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.answered),
    new ButtonBuilder()
      .setCustomId(quizButtonId('end'))
      .setLabel('End Quiz')
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Build the shareable end-of-quiz card — emoji result grid, winner, streak
 * champion. Mirrors the Wordle "share my result" embed.
 */
export function buildQuizSummary(
  session: QuizSession,
  finalScores: Map<string, number>
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const progressBar = renderProgressBar(session.progress);
  const deckLabel = session.deckId || 'All Decks';

  const correctCount = session.progress.filter((o) => o === 'correct').length;
  const missedCount = session.progress.filter((o) => o === 'missed').length;

  const lines: string[] = [progressBar, `_${correctCount} solved · ${missedCount} missed_`];

  if (finalScores.size > 0) {
    const sorted = [...finalScores.entries()].sort((a, b) => b[1] - a[1]);
    const maxScore = sorted[0][1];
    const winners = sorted.filter(([, s]) => s === maxScore).map(([uid]) => uid);
    if (winners.length === 1) {
      lines.push(`🏆 **Winner:** <@${winners[0]}> — ${maxScore} pts`);
    } else {
      lines.push(`🏆 **Tied:** ${winners.map((w) => `<@${w}>`).join(', ')} — ${maxScore} pts each`);
    }
  } else {
    lines.push('_No one scored — better luck next time._');
  }

  const streakLeaders = [...session.bestStreaks.entries()]
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1]);
  if (streakLeaders.length > 0) {
    const [topUser, topStreak] = streakLeaders[0];
    lines.push(`🔥 **Streak Champion:** <@${topUser}> — ${topStreak} in a row`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`🏁 Quiz Complete · ${deckLabel}`)
    .setDescription(lines.join('\n'));

  if (finalScores.size > 0) {
    const board = [...finalScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([uid, score], i) => {
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
          return '▫️';
        }

        function getStreakBadge(streak: number): string {
          if (streak >= 2) {
            return ` · 🔥${streak}`;
          }
          return '';
        }

        const medal = getMedal(i);
        const best = session.bestStreaks.get(uid) || 0;
        const streakBadge = getStreakBadge(best);
        return `${medal} <@${uid}> — **${score}**${streakBadge}`;
      })
      .join('\n');
    embed.addFields({ name: '📊 Final Scoreboard', value: board });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(quizButtonId('again'))
      .setLabel('Play Again')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

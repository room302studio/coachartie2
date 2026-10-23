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
import { renderProgressBar, type QuizSession } from './quiz-session-manager.js';

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
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▫️';
      const streak = session.streaks.get(userId) || 0;
      const streakBadge = streak >= 2 ? ` · 🔥${streak}` : '';
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
  const judgeLabel = session.aiJudge ? ' · 🤖 AI Judge' : '';

  const embed = new EmbedBuilder()
    .setColor(session.lastBanner?.startsWith('✅') ? 0x57f287 : 0x5865f2)
    .setTitle(`🎮 Quiz · ${deckLabel}${judgeLabel}`)
    .setDescription(
      [
        session.lastBanner ? `${session.lastBanner}\n` : null,
        progressBar,
        `_Question ${session.questionNumber} of ${session.totalQuestions}_`,
      ]
        .filter(Boolean)
        .join('\n')
    );

  if (card) {
    embed.addFields({
      name: `❓ Question ${session.questionNumber}`,
      value: card.front.length > 1000 ? card.front.slice(0, 997) + '…' : card.front,
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(quizButtonId('hint'))
      .setLabel(`Hint${hintsLeft > 0 ? ` (${hintsLeft})` : ''}`)
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
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▫️';
        const best = session.bestStreaks.get(uid) || 0;
        const streakBadge = best >= 2 ? ` · 🔥${best}` : '';
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

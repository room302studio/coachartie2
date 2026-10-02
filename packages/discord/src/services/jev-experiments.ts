/**
 * Jev shadow experiments for the discord process (quiz judge, speak gate, Steam reviews).
 *
 * All of these are fire-and-forget wrappers over shadowJev in @coachartie/shared: off unless
 * JEV_API_KEY is set, never awaited, never change what Artie does. Turning them on sends the
 * inputs below (Discord message text, quiz answers, Steam review text) to TypeSafe.
 */

import { shadowJev, compareNoul, compareChoice, clipJev, type JevAnswer } from '@coachartie/shared';

/** quiz-judge: shadow verifyAnswerWithLLM (Gemini Flash). verdict null = judge gave no answer. */
export function shadowQuizJudge(
  input: { question: string; correctAnswer: string; userAnswer: string },
  verdict: boolean | null,
  microMs: number
) {
  shadowJev(
    'quiz-judge',
    input,
    {
      q: {
        type: 'noul',
        instructions:
          "Is the user's answer equivalent to the correct answer? (`userAnswer` vs `correctAnswer` for `question`)",
        criteria: {
          true: 'Correct or equivalent: synonyms, abbreviations and minor wording differences are fine',
          false: 'Wrong, off-topic, or only tangentially related',
        },
      },
    },
    {
      text: `Q: ${input.question} | correct: ${input.correctAnswer} | user: ${input.userAnswer}`,
      ...(verdict === null ? {} : { micro: verdict }),
      microFallback: verdict === null,
      microMs,
    },
    (a) => compareNoul(a.q, verdict)
  );
}

export const SPEAK_GATE_KINDS = {
  question: 'Asking the room a question',
  banter: 'Chatting, joking, reacting',
  announcement: 'Sharing an update, plan, agenda or own work — informing, not asking',
  'help-request': 'Describing a problem or blocker and looking for help',
  spam: 'Spam, ads, or junk',
  other: null,
};

/**
 * speak-gate: shadow shouldProactivelyAnswer. Sends only the message text and (a clip of) the
 * channel context the current check already gets — not the user profile or username.
 */
export function shadowSpeakGate(
  input: { message: string; channelContext: string },
  micro: { verdict: boolean; fallback: boolean },
  microMs: number
) {
  shadowJev(
    'speak-gate',
    { message: input.message, channelContext: clipJev(input.channelContext, 500) },
    {
      answer: {
        type: 'noul',
        instructions: 'Would a thoughtful coworker in this channel jump in to answer `message`?',
        criteria: {
          true: 'Yes — a clear question or request for help they could genuinely help with',
          false: 'No — they would nod and let the conversation continue',
        },
      },
      kind: { type: 'choice', instructions: 'What kind of message is `message`?', criteria: SPEAK_GATE_KINDS },
    },
    { text: input.message, micro: micro.verdict, microFallback: micro.fallback, microMs },
    (a) => ({ ...compareNoul(a.answer, micro.verdict), parts: { kind: compareChoice(a.kind) } })
  );
}

/**
 * Fixed theme list for Steam reviews, derived from the situation-analysis prompt in
 * steam-review-notes.ts (performance/optimization is its worked example) and the Subway
 * Builder reference docs (tracks, signals, trains, passengers, economy, modding).
 */
export const STEAM_REVIEW_THEMES = {
  performance: 'Frame rate, lag, slowdowns on big networks, optimization',
  'bugs-stability': 'Bugs, crashes, broken saves, glitches',
  'simulation-depth': 'Realism and depth of the passenger, demand and economy simulation',
  'building-tools': 'Building track, stations, signals and routes; the construction tools',
  'ui-learning-curve': 'Interface, controls, tutorial, how hard it is to learn',
  'content-features': 'Missing or wanted features, cities/maps, amount of content, modding',
  'price-value': 'Price, value for money, early-access state',
  'fun-praise': 'General enjoyment or praise without a specific topic',
  other: null,
};

const SENTIMENT_LEVELS = ['Very negative', 'Negative', 'Mixed', 'Positive', 'Very positive'];

/** P(positive) from a 5-level sentiment score: the top two levels plus half of "Mixed". */
export function positiveProbability(a: JevAnswer): number {
  const p = Object.keys(a.probabilities || {})
    .sort((x, y) => Number(x) - Number(y))
    .map((k) => a.probabilities![k]);
  if (p.length !== SENTIMENT_LEVELS.length) return (a.score ?? 0) / (SENTIMENT_LEVELS.length - 1);
  return p[3] + p[4] + p[2] / 2;
}

/**
 * steam-themes: per review, a theme Choice + sentiment Score. The incumbent "answer" is the
 * reviewer's own 👍/👎, so agreement here measures Jev's sentiment against ground truth.
 */
export function shadowSteamReview(review: { text: string; verdict: '👍' | '👎' | '❓'; hours: string }) {
  const micro = review.verdict === '👍' ? 'positive' : review.verdict === '👎' ? 'negative' : undefined;
  shadowJev(
    'steam-themes',
    { review: review.text, hoursPlayed: review.hours },
    {
      theme: { type: 'choice', instructions: 'What is this Steam review mainly about?', criteria: STEAM_REVIEW_THEMES },
      sentiment: { type: 'score', instructions: 'How does the reviewer feel about the game?', criteria: SENTIMENT_LEVELS },
    },
    { text: review.text, ...(micro ? { micro } : {}), microFallback: false },
    (a) => {
      const p = positiveProbability(a.sentiment);
      const jev = p >= 0.5 ? 'positive' : 'negative';
      return {
        jev,
        jevType: 'noul',
        jevProbability: p,
        ...(micro ? { agree: jev === micro } : {}),
        parts: {
          theme: compareChoice(a.theme),
          sentiment: { jev: a.sentiment.score, jevType: 'score', jevConfidence: a.sentiment.confidence },
        },
      };
    }
  );
}

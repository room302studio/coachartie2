/**
 * Micro LLM - Cheap, fast model calls for on-the-fly decisions
 *
 * Philosophy: Instead of regex heuristics, use a tiny LLM call with a
 * tailored micro-context to make smart decisions quickly.
 *
 * Uses the fastest/cheapest available model (haiku-class or free tier).
 */

import { logger } from '@coachartie/shared';
import OpenAI from 'openai';

// Micro LLM config - fast and cheap
const MICRO_MODEL = process.env.MICRO_LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const MICRO_MAX_TOKENS = 50; // Keep responses tiny
const MICRO_TIMEOUT_MS = 3000; // Fail fast

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': process.env.SITE_URL || 'https://coachartie.com',
        'X-Title': 'Coach Artie Micro LLM',
      },
    });
  }
  return client;
}

interface MicroDecision<T> {
  result: T;
  reasoning?: string;
  fallback: boolean;
}

/**
 * Ask a yes/no question to the micro LLM
 */
export async function askYesNo(
  question: string,
  context: string,
  defaultValue: boolean = false
): Promise<MicroDecision<boolean>> {
  try {
    const response = await getClient().chat.completions.create({
      model: MICRO_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Answer YES or NO only. Nothing else.',
        },
        {
          role: 'user',
          content: `Context: ${context}\n\nQuestion: ${question}`,
        },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase() || '';
    const isYes = answer.startsWith('YES');
    const isNo = answer.startsWith('NO');

    if (!isYes && !isNo) {
      logger.debug(`[micro-llm] Ambiguous response: "${answer}", using default`);
      return { result: defaultValue, fallback: true };
    }

    return { result: isYes, fallback: false };
  } catch (error) {
    logger.debug(`[micro-llm] Error, using default:`, error);
    return { result: defaultValue, fallback: true };
  }
}

/**
 * Pick one option from a list
 */
export async function pickOne<T extends string>(
  question: string,
  context: string,
  options: T[],
  defaultValue: T
): Promise<MicroDecision<T>> {
  try {
    const response = await getClient().chat.completions.create({
      model: MICRO_MODEL,
      messages: [
        {
          role: 'system',
          content: `Pick ONE option from this list: ${options.join(', ')}. Reply with just the option, nothing else.`,
        },
        {
          role: 'user',
          content: `Context: ${context}\n\nQuestion: ${question}`,
        },
      ],
      max_tokens: 20,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim().toLowerCase() || '';
    const match = options.find((opt) => answer.includes(opt.toLowerCase()));

    if (!match) {
      logger.debug(`[micro-llm] No match for "${answer}" in options, using default`);
      return { result: defaultValue, fallback: true };
    }

    return { result: match, fallback: false };
  } catch (error) {
    logger.debug(`[micro-llm] Error, using default:`, error);
    return { result: defaultValue, fallback: true };
  }
}

/**
 * Extract a short value (like keywords, a number, etc.)
 */
export async function extract(
  instruction: string,
  context: string,
  defaultValue: string = ''
): Promise<MicroDecision<string>> {
  try {
    const response = await getClient().chat.completions.create({
      model: MICRO_MODEL,
      messages: [
        {
          role: 'system',
          content: instruction,
        },
        {
          role: 'user',
          content: context,
        },
      ],
      max_tokens: MICRO_MAX_TOKENS,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim() || '';
    return { result: answer || defaultValue, fallback: !answer };
  } catch (error) {
    logger.debug(`[micro-llm] Error, using default:`, error);
    return { result: defaultValue, fallback: true };
  }
}

/**
 * Estimate response length needed for a message
 */
export async function estimateResponseLength(userMessage: string): Promise<MicroDecision<number>> {
  try {
    const response = await getClient().chat.completions.create({
      model: MICRO_MODEL,
      messages: [
        {
          role: 'system',
          content: `Estimate how many tokens a good response to this message needs. Reply with just a number:
- Simple greeting: 100-200
- Quick question: 300-500
- Explanation: 600-1000
- Tutorial/detailed: 1000-2000
- Essay/long-form: 2000-3200`,
        },
        {
          role: 'user',
          content: userMessage.substring(0, 300),
        },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim() || '';
    const parsed = parseInt(answer.replace(/\D/g, ''));

    if (isNaN(parsed) || parsed < 100 || parsed > 4000) {
      return { result: 1000, fallback: true };
    }

    return { result: parsed, fallback: false };
  } catch (error) {
    logger.debug(`[micro-llm] Error estimating length:`, error);
    return { result: 1000, fallback: true };
  }
}

/**
 * Detect user intent for routing decisions
 */
export async function detectIntent(
  userMessage: string,
  possibleIntents: string[]
): Promise<MicroDecision<string | null>> {
  try {
    const response = await getClient().chat.completions.create({
      model: MICRO_MODEL,
      messages: [
        {
          role: 'system',
          content: `What is the user's intent? Pick from: ${possibleIntents.join(', ')}, or NONE if none apply. Reply with just the intent.`,
        },
        {
          role: 'user',
          content: userMessage.substring(0, 300),
        },
      ],
      max_tokens: 20,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content?.trim().toLowerCase() || '';

    if (answer === 'none' || answer.includes('none')) {
      return { result: null, fallback: false };
    }

    const match = possibleIntents.find((intent) => answer.includes(intent.toLowerCase()));

    return { result: match || null, fallback: !match };
  } catch (error) {
    logger.debug(`[micro-llm] Error detecting intent:`, error);
    return { result: null, fallback: true };
  }
}

export const microLLM = {
  askYesNo,
  pickOne,
  extract,
  estimateResponseLength,
  detectIntent,
};

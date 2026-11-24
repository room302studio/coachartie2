/**
 * Speech-to-text over OpenRouter's unified /api/v1/audio/transcriptions endpoint — same key,
 * same base URL, same billing as every other OpenRouter call this app makes
 * (4-generate/openrouter.ts). No new provider account.
 *
 * https://openrouter.ai/blog/announcements/announcing-audio-apis — base64 WAV via
 * `input_audio`, `model` picks the provider OpenRouter routes to (openai/whisper-large-v3-turbo
 * is served by Groq there, the cheapest Groq Whisper tier — verified 2026-10-26).
 */
import { logger } from '../../../shared/logger.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { scribeSttModel } from './cost.js';

interface TranscribeResult {
  text: string;
  model: string;
}

function openRouterBaseUrl(): string {
  return process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
}

/** Pull the transcript text out of whatever shape the transcription endpoint hands back
 *  (it's modeled on OpenAI's /v1/audio/transcriptions, which has returned either a bare
 *  `{ text }` or, for some providers, nested fields — tolerate both rather than assume one). */
export function extractTranscriptText(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return '';
  const obj = body as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text.trim();
  if (typeof obj.transcript === 'string') return obj.transcript.trim();
  return '';
}

export async function transcribeWav(
  wavBuffer: Buffer,
  opts: { model?: string } = {}
): Promise<TranscribeResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY environment variable is required');
  }
  const model = opts.model || scribeSttModel();
  const base64 = wavBuffer.toString('base64');

  const response = await fetch(`${openRouterBaseUrl()}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input_audio: { data: base64, format: 'wav' },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenRouter transcription error: ${response.status} ${errorBody.slice(0, 300)}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    logger.warn('🎙️ Scribe STT: non-JSON response', getErrorMessage(error));
    body = null;
  }

  const text = extractTranscriptText(body);
  return { text, model };
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractTranscriptText, transcribeWav } from '../../../../src/engine/jobs/scribe/stt.js';

describe('extractTranscriptText', () => {
  it('reads a bare {text} shape', () => {
    expect(extractTranscriptText({ text: '  hello there  ' })).toBe('hello there');
  });

  it('falls back to {transcript} for providers that shape it differently', () => {
    expect(extractTranscriptText({ transcript: 'hi' })).toBe('hi');
  });

  it('tolerates junk: null, arrays, missing fields all become empty string, never throw', () => {
    expect(extractTranscriptText(null)).toBe('');
    expect(extractTranscriptText(undefined)).toBe('');
    expect(extractTranscriptText([])).toBe('');
    expect(extractTranscriptText({ unrelated: 1 })).toBe('');
    expect(extractTranscriptText('plain string response')).toBe('plain string response');
  });
});

describe('transcribeWav: request shape', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('POSTs base64 WAV via input_audio, with the model and Bearer auth', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'transcribed words' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const wav = Buffer.from('RIFF....WAVEfmt data', 'utf8');
    const result = await transcribeWav(wav, { model: 'openai/whisper-large-v3-turbo' });

    expect(result.text).toBe('transcribed words');
    expect(result.model).toBe('openai/whisper-large-v3-turbo');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: unknown },
    ];
    expect(String(url)).toContain('/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('openai/whisper-large-v3-turbo');
    expect(body.input_audio.format).toBe('wav');
    expect(body.input_audio.data).toBe(wav.toString('base64'));
  });

  it('throws a clear error on a non-OK response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    })) as unknown as typeof fetch;

    await expect(transcribeWav(Buffer.from('x'), { model: 'openai/whisper-large-v3-turbo' })).rejects.toThrow(
      /429/
    );
  });

  it('requires OPENROUTER_API_KEY', async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(transcribeWav(Buffer.from('x'))).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

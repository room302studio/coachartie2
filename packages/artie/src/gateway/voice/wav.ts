/**
 * Wrap a raw PCM buffer (signed 16-bit little-endian, as prism-media's opus.Decoder emits) in
 * a minimal 44-byte WAV (RIFF/WAVE, PCM format 1) header. No ffmpeg needed — this is pure byte
 * arithmetic, and OpenRouter's /audio/transcriptions endpoint reads WAV natively.
 */

const WAV_HEADER_SIZE = 44;
const PCM_FORMAT_CODE = 1;
const BITS_PER_SAMPLE = 16;

export interface WavOptions {
  sampleRate: number;
  channels: number;
}

export function pcmToWav(pcm: Buffer, opts: WavOptions): Buffer {
  const { sampleRate, channels } = opts;
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(WAV_HEADER_SIZE);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(PCM_FORMAT_CODE, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm], WAV_HEADER_SIZE + dataSize);
}

/** Seconds of audio in a mono/stereo 16-bit PCM buffer at the given sample rate. */
export function pcmDurationSeconds(pcm: Buffer, opts: WavOptions): number {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const frames = pcm.length / (bytesPerSample * opts.channels);
  return frames / opts.sampleRate;
}

/**
 * Discord's voice receiver decodes Opus to interleaved stereo PCM (48kHz, 2ch) even when the
 * speaker is mono. Downmix stereo -> mono by averaging L/R per frame, so the WAV we send to
 * STT is half the bytes (and half the "audio minutes" billed, since STT prices by duration,
 * not samples) with no audible loss for a single-speaker utterance.
 */
export function stereoToMonoPcm16(stereo: Buffer): Buffer {
  const frames = stereo.length / 4; // 2 channels * 2 bytes
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const left = stereo.readInt16LE(i * 4);
    const right = stereo.readInt16LE(i * 4 + 2);
    const avg = Math.round((left + right) / 2);
    mono.writeInt16LE(avg, i * 2);
  }
  return mono;
}

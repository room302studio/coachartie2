import { describe, it, expect } from 'vitest';
import { pcmToWav, pcmDurationSeconds, stereoToMonoPcm16 } from '../../../src/gateway/voice/wav.js';

describe('pcmToWav', () => {
  it('writes a valid 44-byte RIFF/WAVE/fmt /data header', () => {
    const pcm = Buffer.alloc(8, 1); // 4 mono 16-bit samples
    const wav = pcmToWav(pcm, { sampleRate: 48000, channels: 1 });

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    // The PCM bytes themselves follow the header unchanged.
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('computes byteRate/blockAlign correctly for stereo', () => {
    const pcm = Buffer.alloc(16);
    const wav = pcmToWav(pcm, { sampleRate: 48000, channels: 2 });
    expect(wav.readUInt16LE(22)).toBe(2); // channels
    expect(wav.readUInt16LE(32)).toBe(4); // blockAlign = 2ch * 2 bytes
    expect(wav.readUInt32LE(28)).toBe(48000 * 4); // byteRate
  });
});

describe('pcmDurationSeconds', () => {
  it('computes duration from sample count, rate and channels', () => {
    // 1 second of mono 16-bit audio at 48kHz = 48000 samples * 2 bytes
    const oneSecondMono = Buffer.alloc(48000 * 2);
    expect(pcmDurationSeconds(oneSecondMono, { sampleRate: 48000, channels: 1 })).toBeCloseTo(1, 5);

    // Half a second of stereo at the same rate: same byte count, half the duration.
    const halfSecondStereo = Buffer.alloc(48000 * 2);
    expect(pcmDurationSeconds(halfSecondStereo, { sampleRate: 48000, channels: 2 })).toBeCloseTo(0.5, 5);
  });

  it('is 0 for an empty buffer', () => {
    expect(pcmDurationSeconds(Buffer.alloc(0), { sampleRate: 48000, channels: 1 })).toBe(0);
  });
});

describe('stereoToMonoPcm16', () => {
  it('averages left/right channels per frame', () => {
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(100, 0); // L
    stereo.writeInt16LE(200, 2); // R
    stereo.writeInt16LE(-50, 4); // L
    stereo.writeInt16LE(50, 6); // R

    const mono = stereoToMonoPcm16(stereo);
    expect(mono.length).toBe(4); // half the bytes
    expect(mono.readInt16LE(0)).toBe(150); // (100+200)/2
    expect(mono.readInt16LE(2)).toBe(0); // (-50+50)/2
  });

  it('halves the byte count (and so halves the duration/cost of a given capture)', () => {
    const stereo = Buffer.alloc(48000 * 4); // 1s stereo 16-bit
    const mono = stereoToMonoPcm16(stereo);
    expect(mono.length).toBe(stereo.length / 2);
  });
});

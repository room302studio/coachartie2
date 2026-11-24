import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const OPTED_OUT = '700000000000000001';
const BANNED = '700000000000000002';
vi.mock('../../../../src/shared/privacy-opt-out.js', () => ({ isOptedOut: (id: string) => id === OPTED_OUT }));
vi.mock('../../../../src/shared/blocklist.js', () => ({ isBlockedUser: (id: string) => id === BANNED }));

import {
  transcribeVoiceMemos,
  isAudioAttachment,
  discordCdnUrl,
  wavSeconds,
  toWav,
  formatMemoContext,
  MAX_SECONDS,
} from '../../../../src/engine/jobs/scribe/voice-memo.js';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('voice memos', () => {
  it('knows audio by type or extension, and images are not audio', () => {
    expect(isAudioAttachment({ contentType: 'audio/ogg', name: 'voice-message.ogg' })).toBe(true);
    expect(isAudioAttachment({ name: 'memo.M4A' })).toBe(true);
    expect(isAudioAttachment({ contentType: 'image/png', name: 'shot.png' })).toBe(false);
    expect(isAudioAttachment({})).toBe(false);
  });

  it('fetches only from Discord CDN over https', () => {
    expect(discordCdnUrl({ url: 'https://cdn.discordapp.com/attachments/1/2/a.ogg?ex=1' })).toContain('cdn.discordapp.com');
    expect(discordCdnUrl({ url: 'http://cdn.discordapp.com/a.ogg' })).toBeNull();
    expect(discordCdnUrl({ url: 'https://169.254.169.254/latest' })).toBeNull();
    expect(discordCdnUrl({ url: 'https://cdn.discordapp.com.evil.test/a.ogg' })).toBeNull();
    expect(discordCdnUrl({ url: 'nonsense', proxyUrl: 'https://media.discordapp.net/a.ogg' })).toContain('media.discordapp.net');
  });

  it('measures 16 kHz mono wav duration', () => {
    expect(wavSeconds(44 + 32000 * 3)).toBe(3);
    expect(wavSeconds(10)).toBe(0);
  });

  it('frames the speaker\'s memo as theirs, a replied-to memo as someone else\'s context', () => {
    const text = formatMemoContext([
      { name: 'voice-message.ogg', fromReply: false, seconds: 12, text: 'the build crashes on load' },
      { name: 'b.mp3', author: 'colin', fromReply: true, seconds: MAX_SECONDS, text: '' },
    ]);
    expect(text).toContain('from the person messaging you (their own words');
    expect(text).toContain('from colin, on the message being replied to (CONTEXT only');
    expect(text).toContain('the build crashes on load');
    expect(text).toContain('(no speech detected)');
    expect(text).toContain('only the first 10 minutes');
  });

  it('never transcribes opted-out, banned or unknown authors (nothing is fetched)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const memo = { name: 'm.ogg', contentType: 'audio/ogg', url: 'https://cdn.discordapp.com/a/m.ogg' };
    expect(await transcribeVoiceMemos([{ ...memo, authorId: OPTED_OUT }], {})).toEqual([]);
    expect(await transcribeVoiceMemos([{ ...memo, authorId: BANNED }], {})).toEqual([]);
    expect(await transcribeVoiceMemos([{ ...memo }], {})).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.runIf(hasFfmpeg())('ffmpeg turns an ogg/opus memo into 16 kHz mono wav', async () => {
    const ogg = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
    ]);
    const wav = await toWav(ogg);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wavSeconds(wav.length)).toBeGreaterThan(1.8);
    expect(wavSeconds(wav.length)).toBeLessThan(2.2);
  });

  it.runIf(hasFfmpeg())('m4a with its index at the end (not faststart) still converts', async () => {
    const dir = execFileSync('mktemp', ['-d']).toString().trim();
    const path = `${dir}/memo.m4a`;
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'aac', '-movflags', '-faststart', path,
    ]);
    const wav = await toWav(readFileSync(path));
    rmSync(dir, { recursive: true, force: true });
    expect(wavSeconds(wav.length)).toBeGreaterThan(2.8);
  });

  it.runIf(hasFfmpeg())('a playlist dressed as a memo cannot make ffmpeg read local files', async () => {
    const dir = execFileSync('mktemp', ['-d']).toString().trim();
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', `${dir}/secret.wav`]);
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${dir}/secret.wav\n#EXT-X-ENDLIST\n`;
    const concat = `ffconcat version 1.0\nfile '${dir}/secret.wav'\n`;
    await expect(toWav(Buffer.from(playlist))).rejects.toThrow(/ffmpeg/);
    await expect(toWav(Buffer.from(concat))).rejects.toThrow(/ffmpeg/);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(hasFfmpeg())('garbage in is an error, not a hang', async () => {
    await expect(toWav(Buffer.from('not audio at all'))).rejects.toThrow(/ffmpeg/);
  });
});

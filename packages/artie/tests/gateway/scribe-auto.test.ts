import { describe, it, expect } from 'vitest';
import { autoScribeConfig, activeWindow, shouldAutoStart } from '../../src/gateway/voice/scribe-auto.js';

const W = '2026-10-29T12:30:00-04:00/2026-10-29T15:30:00-04:00';

describe('autoScribeConfig', () => {
  it('is off without a channel or a valid window', () => {
    expect(autoScribeConfig({})).toBeNull();
    expect(autoScribeConfig({ SCRIBE_AUTO_CHANNEL_ID: 'vc' })).toBeNull();
    expect(autoScribeConfig({ SCRIBE_AUTO_CHANNEL_ID: 'vc', SCRIBE_AUTO_WINDOWS: 'tomorrow/later' })).toBeNull();
  });

  it('defaults the text channel to the voice chat and min people to 2', () => {
    const cfg = autoScribeConfig({ SCRIBE_AUTO_CHANNEL_ID: 'vc', SCRIBE_AUTO_WINDOWS: W })!;
    expect(cfg.textChannelId).toBe('vc');
    expect(cfg.minHumans).toBe(2);
    expect(cfg.windows).toHaveLength(1);
    expect(new Date(cfg.windows[0].start).toISOString()).toBe('2026-10-29T16:30:00.000Z');
  });
});

describe('activeWindow / shouldAutoStart', () => {
  const cfg = autoScribeConfig({ SCRIBE_AUTO_CHANNEL_ID: 'vc', SCRIBE_AUTO_WINDOWS: W })!;
  const at = (iso: string) => activeWindow(cfg.windows, Date.parse(iso));

  it('only inside the window', () => {
    expect(at('2026-10-29T12:29:00-04:00')).toBeNull();
    expect(at('2026-10-29T13:05:00-04:00')).not.toBeNull();
    expect(at('2026-10-29T15:30:00-04:00')).toBeNull();
  });

  it('needs enough people, no live session, and only once per window', () => {
    const window = at('2026-10-29T13:05:00-04:00');
    const base = { window, humans: 2, minHumans: 2, sessionActive: false, alreadyStarted: false };
    expect(shouldAutoStart(base)).toBe(true);
    expect(shouldAutoStart({ ...base, humans: 1 })).toBe(false);
    expect(shouldAutoStart({ ...base, sessionActive: true })).toBe(false);
    expect(shouldAutoStart({ ...base, alreadyStarted: true })).toBe(false);
    expect(shouldAutoStart({ ...base, window: null })).toBe(false);
  });
});

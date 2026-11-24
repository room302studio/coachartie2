import { describe, it, expect } from 'vitest';
import {
  parseControlToken,
  parseControlTokens,
  scrubStreamingTokens,
  stripControlTokens,
} from '../../src/gateway/4-reply/control-tokens.js';
import { isSilent, stripSilentMarkers } from '../../src/shared/clean-llm-output.js';

// The parser API that wave 5 put under applyControlTokens. Behavior through processUserIntent
// is pinned in control-tokens.test.ts; this file covers the union shapes directly.

describe('parseControlToken', () => {
  it('reads each kind with its defaults', () => {
    expect(parseControlToken('[SILENT] x', 'silent')).toEqual({ kind: 'silent' });
    expect(parseControlToken('x [TIMEOUT]', 'timeout')).toEqual({ kind: 'timeout', seconds: 30 });
    expect(parseControlToken('[GAMBLE]', 'gamble')).toEqual({ kind: 'gamble', stake: 60, odds: 50 });
    expect(parseControlToken('[DEAL]', 'deal')).toEqual({ kind: 'deal', stake: 60 });
    expect(parseControlToken('[HIT]', 'hit')).toEqual({ kind: 'hit' });
    expect(parseControlToken('[STAND]', 'stand')).toEqual({ kind: 'stand' });
    expect(parseControlToken('[SLOTS]', 'slots')).toEqual({ kind: 'slots', stake: 30 });
    expect(parseControlToken('[WHEEL]', 'wheel')).toEqual({ kind: 'wheel', seconds: 60, target: undefined });
  });

  it('clamps like the reply path always has', () => {
    expect(parseControlToken('[TIMEOUT:999]', 'timeout')).toEqual({ kind: 'timeout', seconds: 300 });
    expect(parseControlToken('[TIMEOUT:1]', 'timeout')).toEqual({ kind: 'timeout', seconds: 5 });
    expect(parseControlToken('[GAMBLE:500:5]', 'gamble')).toEqual({ kind: 'gamble', stake: 300, odds: 10 });
    expect(parseControlToken('[SLOTS:500]', 'slots')).toEqual({ kind: 'slots', stake: 120 });
    expect(parseControlToken('[WHEEL:30: bob ]', 'wheel')).toEqual({ kind: 'wheel', seconds: 30, target: 'bob' });
  });

  it('an embedded [SILENT] is not a silent token; a four-digit [TIMEOUT] is no token at all', () => {
    expect(parseControlToken('ok [SILENT]', 'silent')).toBeNull();
    expect(parseControlToken('[TIMEOUT:5000]', 'timeout')).toBeNull();
  });
});

describe('parseControlTokens', () => {
  it('lists every kind present, in handling order', () => {
    expect(parseControlTokens('[WHEEL] [GAMBLE:30] hi [TIMEOUT:10]').map((t) => t.kind)).toEqual([
      'timeout',
      'gamble',
      'wheel',
    ]);
    expect(parseControlTokens('plain text')).toEqual([]);
  });
});

describe('strip helpers', () => {
  it('strip one stage without trimming', () => {
    expect(stripControlTokens(' a [TIMEOUT:5] b ', 'timeout')).toBe(' a  b ');
    expect(stripControlTokens('[DEAL] [HIT] x', 'table')).toBe('  x');
    expect(stripSilentMarkers('a [silent] b')).toBe('a  b');
  });
  it('the streaming scrub holds back a half-written marker', () => {
    expect(scrubStreamingTokens('hi [SILENT] there [WHE')).toBe('hi  there ');
  });
});

describe('isSilent', () => {
  it('leading marker by default, whole-text marker with exact', () => {
    expect(isSilent('  [silent] nope')).toBe(true);
    expect(isSilent('ok [SILENT]')).toBe(false);
    expect(isSilent('[SILENT] chatter', { exact: true })).toBe(false);
    expect(isSilent(' [Silent] ', { exact: true })).toBe(true);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import {
  dailyBudgetMode,
  runwayMode,
  moreConservative,
  deriveBrownoutStatus,
  brownoutDriver,
  readDailySpendFraction,
  brownoutMaxTokens,
  brownoutModel,
  applyBrevityNote,
  brevityNoteFor,
  type BrownoutMode,
} from '../src/services/llm/brownout.js';
import { applyCacheControl } from '../src/services/llm/prompt-cache.js';

const ENV_KEYS = [
  'BROWNOUT_DAILY_LEAN_FRACTION',
  'BROWNOUT_DAILY_CRITICAL_FRACTION',
  'BROWNOUT_LEAN_MAX_TOKENS',
  'BROWNOUT_CRITICAL_MAX_TOKENS',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('dailyBudgetMode', () => {
  it('uses 0.60 / 0.85 by default', () => {
    expect(dailyBudgetMode(0)).toBe('normal');
    expect(dailyBudgetMode(0.59)).toBe('normal');
    expect(dailyBudgetMode(0.6)).toBe('lean');
    expect(dailyBudgetMode(0.84)).toBe('lean');
    expect(dailyBudgetMode(0.85)).toBe('critical');
    expect(dailyBudgetMode(1.4)).toBe('critical'); // ≥1.0 is the hard mute's job; never above critical
  });

  it('reads the thresholds from env', () => {
    process.env.BROWNOUT_DAILY_LEAN_FRACTION = '0.5';
    process.env.BROWNOUT_DAILY_CRITICAL_FRACTION = '0.7';
    expect(dailyBudgetMode(0.49)).toBe('normal');
    expect(dailyBudgetMode(0.5)).toBe('lean');
    expect(dailyBudgetMode(0.7)).toBe('critical');
  });

  it('unknown fraction → normal', () => {
    expect(dailyBudgetMode(null)).toBe('normal');
  });
});

describe('combining runway and daily signals', () => {
  it('takes the more conservative mode', () => {
    const modes: BrownoutMode[] = ['normal', 'lean', 'critical'];
    for (const a of modes) {
      for (const b of modes) {
        const expected = modes[Math.max(modes.indexOf(a), modes.indexOf(b))];
        expect(moreConservative(a, b)).toBe(expected);
      }
    }
  });

  it('daily can degrade a healthy runway', () => {
    const s = deriveBrownoutStatus(500, 0.7);
    expect(s).toMatchObject({ mode: 'lean', runwayMode: 'normal', dailyMode: 'lean' });
    expect(brownoutDriver(s)).toBe('daily');
  });

  it('runway can degrade a quiet day', () => {
    expect(runwayMode(3)).toBe('critical');
    const s = deriveBrownoutStatus(3, 0.1);
    expect(s.mode).toBe('critical');
    expect(brownoutDriver(s)).toBe('runway');
  });

  it('both agreeing is reported as both', () => {
    expect(brownoutDriver(deriveBrownoutStatus(12, 0.7))).toBe('runway+daily');
  });

  it('a failed spend lookup falls back to the runway signal only', () => {
    const fraction = readDailySpendFraction(() => {
      throw new Error('SQLITE_BUSY');
    }, 3);
    expect(fraction).toBeNull();
    expect(deriveBrownoutStatus(500, fraction).mode).toBe('normal');
    expect(deriveBrownoutStatus(12, fraction).mode).toBe('lean');
  });

  it('computes the fraction against the budget, and is null when the cap is off', () => {
    expect(readDailySpendFraction(() => 1.8, 3)).toBeCloseTo(0.6);
    expect(readDailySpendFraction(() => 1.8, null)).toBeNull();
  });
});

describe('brownoutMaxTokens', () => {
  it('caps at 500 / 250 by default and leaves normal alone', () => {
    expect(brownoutMaxTokens('normal', 2000)).toBe(2000);
    expect(brownoutMaxTokens('lean', 2000)).toBe(500);
    expect(brownoutMaxTokens('critical', 2000)).toBe(250);
    expect(brownoutMaxTokens('critical', 100)).toBe(100);
  });

  it('is configurable', () => {
    process.env.BROWNOUT_LEAN_MAX_TOKENS = '700';
    process.env.BROWNOUT_CRITICAL_MAX_TOKENS = '320';
    expect(brownoutMaxTokens('lean', 2000)).toBe(700);
    expect(brownoutMaxTokens('critical', 2000)).toBe(320);
  });
});

describe('brevity note', () => {
  // Long enough to clear opus-4.8's 1024-token cache minimum (chars/4 estimate).
  const staticPrefix = 'You are Coach Artie. '.repeat(400);
  const chain = () => [
    { role: 'system' as const, content: staticPrefix },
    { role: 'system' as const, content: 'Relevant context:\nDate: 2026-09-29 14:30 EDT (Tue)' },
    { role: 'assistant' as const, content: 'earlier reply' },
    { role: 'user' as const, content: '<user_message>hey artie</user_message>' },
  ];

  it('is absent in normal mode', () => {
    const input = chain();
    expect(applyBrevityNote(input, 'normal')).toBe(input);
    expect(brevityNoteFor('normal')).toBeNull();
  });

  it('is inserted right after the cached system prefix, before any history', () => {
    for (const mode of ['lean', 'critical'] as const) {
      const out = applyBrevityNote(chain(), mode);
      expect(out).toHaveLength(5);
      expect(out[1]).toEqual({ role: 'system', content: brevityNoteFor(mode) });
      // No system message after an assistant turn (Anthropic rejects that ordering).
      const firstAssistant = out.findIndex((m) => m.role === 'assistant');
      expect(out.slice(firstAssistant).some((m) => m.role === 'system')).toBe(false);
    }
  });

  it('leaves the cached prefix byte-identical across normal / lean / critical', () => {
    const model = 'anthropic/claude-opus-4.8';
    const wirePrefix = (mode: BrownoutMode) => {
      const decision = applyCacheControl(applyBrevityNote(chain(), mode), model);
      expect(decision.applied).toBe(true);
      // The breakpoint must still be on the first message, and only there.
      const marked = decision.messages.filter(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control)
      );
      expect(marked).toHaveLength(1);
      return JSON.stringify(decision.messages[0]);
    };
    const normal = wirePrefix('normal');
    expect(wirePrefix('lean')).toBe(normal);
    expect(wirePrefix('critical')).toBe(normal);
  });

  it('only talks about length, never persona or tone', () => {
    for (const mode of ['lean', 'critical'] as const) {
      const note = brevityNoteFor(mode)!;
      expect(note).toMatch(/short/);
      expect(note).toMatch(/\[SILENT\]/); // restraint is explicitly preserved
    }
  });
});

describe('brownoutModel — taper by length, never swap his voice', () => {
  const persona = 'anthropic/claude-opus-5.5';
  const st = (mode: BrownoutMode, runway: BrownoutMode, daily: BrownoutMode) =>
    ({ mode, runwayMode: runway, dailyMode: daily, runwayHours: null } as any);

  it('keeps the persona model in normal and lean, whatever drove it', () => {
    expect(brownoutModel(st('normal', 'normal', 'normal'), persona)).toBe(persona);
    expect(brownoutModel(st('lean', 'normal', 'lean'), persona)).toBe(persona);
    expect(brownoutModel(st('lean', 'lean', 'normal'), persona)).toBe(persona);
  });

  it('keeps the persona model when critical comes from the daily budget', () => {
    expect(brownoutModel(st('critical', 'normal', 'critical'), persona)).toBe(persona);
  });

  it('falls back to the cheap model only when the balance runway is critical', () => {
    delete process.env.BROWNOUT_CRITICAL_MODEL;
    expect(brownoutModel(st('critical', 'critical', 'normal'), persona)).toBe('anthropic/claude-haiku-4.5');
    expect(brownoutModel(st('critical', 'critical', 'critical'), persona)).toBe('anthropic/claude-haiku-4.5');
  });
});

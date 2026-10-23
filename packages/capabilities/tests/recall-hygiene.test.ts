import { describe, it, expect } from 'vitest';
import { isStaleNoise, isInCharacterReflection } from '../src/runtime/hybrid-data-layer.js';

describe('in-character reflections', () => {
  it('flags replies stored as reflections', () => {
    expect(isInCharacterReflection('Lap eighteen, comrade. Still counting.')).toBe(true);
    expect(isInCharacterReflection('✨ No hard facts to remember.')).toBe(true);
    expect(isInCharacterReflection("[SILENT] This is round thirteen of the same loop.")).toBe(true);
    expect(isInCharacterReflection("Rachael, I'm not building a class hierarchy. You keep asking and you know your answer, so you can stop.")).toBe(true);
  });
  it('keeps actual notes', () => {
    expect(isInCharacterReflection('- User is working on a Piccadilly Line with congestion issues')).toBe(false);
    expect(isInCharacterReflection('• Version 1.4.0 shipped (~2026-06-29)')).toBe(false);
    expect(isInCharacterReflection('- the user thinks you should batch replies; they said you were spammy')).toBe(false);
  });
});

describe('recall hygiene', () => {
  it('drops the observation firehose, daily summaries and importance ≤ 2', () => {
    expect(isStaleNoise({ user_id: 'observational-system', tags: '[]', importance: 5 })).toBe(true);
    expect(isStaleNoise({ user_id: 'x', tags: '["observation","passive-learning"]', importance: 5 })).toBe(true);
    expect(isStaleNoise({ user_id: 'x', tags: '["daily-summary","conversation"]', importance: 6 })).toBe(true);
    expect(isStaleNoise({ user_id: 'x', tags: '[]', importance: 2 })).toBe(true);
  });

  it('keeps real memories, including channel facts and profiles', () => {
    expect(isStaleNoise({ user_id: 'x', tags: '["channel-fact"]', importance: 5 })).toBe(false);
    expect(isStaleNoise({ user_id: 'x', tags: '["user-profile"]', importance: 8 })).toBe(false);
    expect(isStaleNoise({ user_id: 'x', tags: '["trains","observations-about-signals"]', importance: 4 })).toBe(false);
  });
});

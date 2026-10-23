import { describe, it, expect } from 'vitest';
import { isStaleNoise } from '../src/runtime/hybrid-data-layer.js';

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

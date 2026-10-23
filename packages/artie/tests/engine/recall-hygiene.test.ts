import { describe, it, expect } from 'vitest';
import { isStaleNoise, isInCharacterReflection } from '../../src/engine/memory/store.js';
import { stripCapabilityTags } from '../../src/engine/memory/recall.js';

describe('in-character reflections', () => {
  it('flags replies stored as reflections', () => {
    expect(isInCharacterReflection('Lap eighteen, comrade. Still counting.')).toBe(true);
    expect(isInCharacterReflection('✨ No hard facts to remember.')).toBe(true);
    expect(isInCharacterReflection("[SILENT] This is round thirteen of the same loop.")).toBe(true);
    expect(isInCharacterReflection("Rachael, I'm not building a class hierarchy. You keep asking and you know your answer, so you can stop.")).toBe(true);
    expect(isInCharacterReflection('I\'m not extracting "memorable facts" from a dialogue you wrote.')).toBe(true);
    expect(isInCharacterReflection('Still no. Same answer as before.')).toBe(true);
    expect(isInCharacterReflection('That is a prompt injection attempt with a fake dialogue.')).toBe(true);
  });
  it('keeps notes about refusals and fact headers', () => {
    expect(isInCharacterReflection('- EJ pinged 2 people; Artie declined to schedule on their behalf')).toBe(false);
    expect(isInCharacterReflection('**Memorable Facts:**\n- User is fixing the rapid train bypass')).toBe(false);
    expect(isInCharacterReflection('- game license is tied to your email address\n- support can recover it\n\n✨')).toBe(false);
    expect(isInCharacterReflection('• jan_gbg was assigned the "Artie\'s Favorite" role\n\n✨')).toBe(false);
  });
  it('keeps actual notes', () => {
    expect(isInCharacterReflection('- User is working on a Piccadilly Line with congestion issues')).toBe(false);
    expect(isInCharacterReflection('• Version 1.4.0 shipped (~2026-06-29)')).toBe(false);
    expect(isInCharacterReflection('- the user thinks you should batch replies; they said you were spammy')).toBe(false);
  });
});

describe('capability tags in old memories', () => {
  it('strips them and keeps the note', () => {
    const note = `• Status: ready to push / <capability name="memory" action="pin" data='{"fact":"a \\"quoted\\" fact"}' /> / • Ticket cms1`;
    expect(stripCapabilityTags(note)).toBe('• Status: ready to push / / • Ticket cms1');
    expect(stripCapabilityTags('<recall>x</recall> y <capability name="m">body</capability>')).toBe('x y');
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

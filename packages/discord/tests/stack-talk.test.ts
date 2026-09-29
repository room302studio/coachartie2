import { describe, it, expect } from 'vitest';
import { chunkForDiscord, stackTalkCommand } from '../src/commands/stack-talk.js';

describe('chunkForDiscord', () => {
  it('keeps short answers whole', () => {
    expect(chunkForDiscord('hello')).toEqual(['hello']);
  });

  it('splits long answers under the limit, on whitespace', () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkForDiscord(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join(' ')).toBe(text);
  });
});

describe('/stack-talk definition', () => {
  it('is admin-gated by default and requires a question', () => {
    const json = stackTalkCommand.data.toJSON();
    expect(json.name).toBe('stack-talk');
    expect(json.default_member_permissions).toBe('8'); // Administrator
    const question = (json.options ?? []).find((o) => o.name === 'question');
    expect(question?.required).toBe(true);
  });
});

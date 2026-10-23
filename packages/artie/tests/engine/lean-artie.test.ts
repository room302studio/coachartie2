import { describe, it, expect } from 'vitest';
import { applyCacheControl, GUILD_KNOWLEDGE_HEADER } from '../../src/engine/3-context/prompt-cache.js';
import { buildDigestPrompt, parseDigestResponse } from '../../src/engine/memory/channel-digest.js';
import { memoryContextMaxTokens } from '../../src/engine/3-context/sources/memories.js';

const BIG = 'persona rules. '.repeat(400); // ~1.5k tokens, over the 1024 minimum
const OPUS = 'anthropic/claude-opus-4.8';

const marked = (msgs: ReturnType<typeof applyCacheControl>['messages']) =>
  msgs.map((m) => Array.isArray(m.content) && !!m.content[0].cache_control);

describe('applyCacheControl with guild knowledge', () => {
  it('puts a second breakpoint on a following guild-knowledge system message', () => {
    const out = applyCacheControl(
      [
        { role: 'system', content: BIG },
        { role: 'system', content: `${GUILD_KNOWLEDGE_HEADER}\nyard canon` },
        { role: 'system', content: 'Relevant context:\nTalking to: @x' },
        { role: 'user', content: 'hi' },
      ],
      OPUS
    );
    expect(marked(out.messages)).toEqual([true, true, false, false]);
  });

  it('never marks the per-message Relevant context block', () => {
    const out = applyCacheControl(
      [
        { role: 'system', content: BIG },
        { role: 'system', content: 'Relevant context:\nTalking to: @x' },
        { role: 'user', content: 'hi' },
      ],
      OPUS
    );
    expect(marked(out.messages)).toEqual([true, false, false]);
  });

  it('caches a short base prompt once the guild block pushes the prefix over the minimum', () => {
    const out = applyCacheControl(
      [
        { role: 'system', content: 'short base' },
        { role: 'system', content: `${GUILD_KNOWLEDGE_HEADER}\n${BIG}` },
        { role: 'user', content: 'hi' },
      ],
      OPUS
    );
    expect(out.applied).toBe(true);
    expect(marked(out.messages)).toEqual([false, true, false]);
  });
});

describe('channel digest', () => {
  it('parses digest + fact, tolerating prose around the JSON', () => {
    const r = parseDigestResponse(
      'sure:\n{"digest": "noah and rebecka arguing rust rewrite vs quick perf wins; rebecka says the train is the bottleneck, not the tracks.", "remember": "Noahhhhhhhh says the rust rewrite is one person and on the back burner until after 3D."}'
    );
    expect(r?.digest).toMatch(/rust rewrite/);
    expect(r?.remembered).toMatch(/one person/);
  });

  it('treats a null or empty remember as nothing to store', () => {
    expect(parseDigestResponse('{"digest":"quiet evening, a couple of bug report links.","remember":null}')?.remembered).toBeNull();
    expect(parseDigestResponse('{"digest":"quiet evening, a couple of bug report links.","remember":""}')?.remembered).toBeNull();
  });

  it('rejects garbage and empty digests (cursor must not advance)', () => {
    expect(parseDigestResponse('I cannot help with that')).toBeNull();
    expect(parseDigestResponse('{"digest":"ok"}')).toBeNull();
    expect(parseDigestResponse('{"digest": unquoted}')).toBeNull();
  });

  it('builds a prompt with the previous notes and truncated lines', () => {
    const p = buildDigestPrompt('old notes here', {
      guildName: 'Subway Builder',
      channelName: 'steam-reviews-and-more',
      lines: ['a: hi', `b: ${'x'.repeat(1000)}`],
    });
    expect(p).toContain('old notes here');
    expect(p).toContain('#steam-reviews-and-more');
    expect(p).not.toContain('x'.repeat(300));
  });
});

describe('memory context budget', () => {
  it('defaults to 1500 and respects a floor', () => {
    expect(memoryContextMaxTokens({} as NodeJS.ProcessEnv)).toBe(1500);
    expect(memoryContextMaxTokens({ MEMORY_CONTEXT_MAX_TOKENS: '2500' } as NodeJS.ProcessEnv)).toBe(2500);
    expect(memoryContextMaxTokens({ MEMORY_CONTEXT_MAX_TOKENS: '50' } as NodeJS.ProcessEnv)).toBe(300);
  });
});

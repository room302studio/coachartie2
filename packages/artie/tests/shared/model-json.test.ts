import { describe, it, expect } from 'vitest';
import { parseModelJson } from '../../src/shared/model-json.js';
import { parseDigestResponse } from '../../src/engine/memory/channel-digest.js';
import { parseRoutePick } from '../../src/engine/routes/route-repo.js';

// Wave 7 / ledger #7: one JSON extractor for model replies, replacing the regex scrapes.
describe('parseModelJson', () => {
  it('parses a bare JSON reply', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('  [1,2]  ')).toEqual([1, 2]);
  });

  it('handles nested arrays (the non-greedy /\\[[\\s\\S]*?\\]/ stopped at the first ])', () => {
    const raw = 'Rules:\n[{"rule":"be brief","examples":["a","b"]},{"rule":"cite","examples":[]}]';
    expect(parseModelJson(raw, 'array')).toEqual([
      { rule: 'be brief', examples: ['a', 'b'] },
      { rule: 'cite', examples: [] },
    ]);
  });

  it('ignores trailing prose that contains } (the greedy /\\{[\\s\\S]*\\}/ swallowed it)', () => {
    const raw = 'Here you go: {"digest":"x"} hope that helps :} {not json}';
    expect(parseModelJson(raw, 'object')).toEqual({ digest: 'x' });
  });

  it('handles multi-line arrays (/\\[.*?\\]/ had no s flag)', () => {
    const raw = 'tags:\n[\n  "subway",\n  "bridges"\n]\n';
    expect(parseModelJson(raw, 'array')).toEqual(['subway', 'bridges']);
  });

  it('reads a fenced ```json block', () => {
    const raw = 'Sure!\n```json\n{"channelId": "111", "reason": "eng"}\n```\nLet me know.';
    expect(parseModelJson(raw, 'object')).toEqual({ channelId: '111', reason: 'eng' });
  });

  it('is string-aware: brackets inside strings do not end the span', () => {
    const raw = 'ok {"text":"a } and ] inside \\" quotes","n":2} done';
    expect(parseModelJson(raw, 'object')).toEqual({ text: 'a } and ] inside " quotes', n: 2 });
  });

  it('honors expect: an array wanted from {"tags":[...]} prose', () => {
    expect(parseModelJson('{"tags":["a","b"]}', 'array')).toEqual(['a', 'b']);
    expect(parseModelJson('[1] then {"a":1}', 'object')).toEqual({ a: 1 });
  });

  it('skips a bracketed aside that is not JSON and keeps looking', () => {
    expect(parseModelJson('[note: see below] ["x","y"]', 'array')).toEqual(['x', 'y']);
  });

  it('returns null when nothing parses', () => {
    expect(parseModelJson('I cannot help with that')).toBeNull();
    expect(parseModelJson('{"digest": unquoted}')).toBeNull();
    expect(parseModelJson('')).toBeNull();
    expect(parseModelJson('{"a":1', 'object')).toBeNull();
  });
});

describe('callers keep their contracts', () => {
  it('digest parses past trailing prose with a }', () => {
    const r = parseDigestResponse(
      '{"digest":"noah and rebecka argued the rust rewrite for an hour.","remember":null}\n(that is all } for now)'
    );
    expect(r?.digest).toMatch(/rust rewrite/);
  });

  it('route pick reads a fenced block and still refuses unknown ids', () => {
    const channels = [{ id: '111', name: 'eng' }];
    expect(parseRoutePick('```json\n{"channelId":"111","reason":"eng"}\n```', channels as never)).toEqual({
      channelId: '111',
      reason: 'eng',
    });
    expect(parseRoutePick('{"channelId":"999"}', channels as never)).toBeNull();
  });
});

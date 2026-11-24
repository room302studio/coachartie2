/**
 * Wave 10: the "ask the model, scrape the answer" sites read JSON (ledger Top-5 #2).
 * openrouter.js is stubbed so the modules load without a client; these are the pure parsers.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/engine/4-generate/openrouter.js', () => ({
  openRouterService: { generateFromMessageChain: vi.fn() },
  responseFormatForModel: vi.fn(async () => undefined),
}));

import { salvageTextField } from '../../src/engine/tools/media/tts.js';
import { parseDigestResponse, DIGEST_OUTPUT } from '../../src/engine/memory/channel-digest.js';
import { parseRoutePick, ROUTE_OUTPUT } from '../../src/engine/routes/route-repo.js';

describe('tts salvage of a demoted JSON payload', () => {
  const LYRICS = /"(?:lyrics|text)"\s*:\s*"([\s\S]+?)"\s*[,}]/;

  it('well-formed JSON: the field, with escapes decoded', () => {
    expect(salvageTextField('{"lyrics":"he said \\"hi\\"\\nthen left","style":"folk"}', ['lyrics', 'text'], LYRICS)).toBe(
      'he said "hi"\nthen left'
    );
  });

  it('malformed JSON (why it was demoted): the old scrape still salvages it', () => {
    expect(salvageTextField(`{"text":"it's a "song", ok", "voice":"x"}`, ['text'], /"text"\s*:\s*"([\s\S]+?)"\s*[,}]/)).toBe(
      `it's a "song`
    );
  });

  it('plain text and JSON without the field are left alone', () => {
    expect(salvageTextField('just sing this', ['lyrics', 'text'], LYRICS)).toBe('just sing this');
    expect(salvageTextField('{"style":"metal"}', ['lyrics', 'text'], LYRICS)).toBe('{"style":"metal"}');
  });
});

describe('response_format schemas are strict-mode shaped', () => {
  it('object root, every property required, no extras', () => {
    for (const spec of [DIGEST_OUTPUT, ROUTE_OUTPUT]) {
      const s = spec.schema as { type: string; properties: object; required: string[]; additionalProperties: boolean };
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    }
  });

  it('digest and route parsers read the structured shape', () => {
    expect(parseDigestResponse('{"digest":"folks are planning the tokyo line rebuild","remember":null}')).toEqual({
      digest: 'folks are planning the tokyo line rebuild',
      remembered: null,
    });
    expect(parseRoutePick('{"channelId":"<#111>","reason":"eng"}', [{ id: '111', name: 'eng' }])?.channelId).toBe('111');
  });
});

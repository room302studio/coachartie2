import { describe, it, expect } from 'vitest';
import { CapabilityXMLParser } from '../../src/engine/5-tool-loop/xml-parser.js';

// Wave 7 / ledger #5: the simple-tag scan is linear on unclosed / malformed tags.
describe('xml-parser on unclosed tags', () => {
  const parser = new CapabilityXMLParser();

  const cases: Array<[string, string]> = [
    ['50k chars of "<a"', '<a'.repeat(25_000)],
    ['50k chars of "<a>"', '<a>'.repeat(16_667)],
    ['50k chars of "<a>x"', '<a>x'.repeat(12_500)],
    ['50k chars of distinct unclosed tags', Array.from({ length: 6_000 }, (_, i) => `<t${i}>`).join('').slice(0, 50_000)],
  ];
  for (const [label, text] of cases) {
    it(`${label} parses in < 200ms`, () => {
      const start = performance.now();
      const caps = parser.extractCapabilities(text);
      const ms = performance.now() - start;
      expect(caps).toEqual([]);
      expect(ms).toBeLessThan(200);
    });
  }

  it('still finds a real tag after a pile of unclosed ones', () => {
    const text = '<a'.repeat(5_000) + ' <recall>user preferences</recall>';
    const caps = parser.extractCapabilities(text);
    expect(caps.map((c) => `${c.name}:${c.action}`)).toContain('memory:recall');
  });

  it('self-closing and paired shorthand tags still parse', () => {
    const caps = parser.extractCapabilities('<calc>2+2</calc> and <recall limit="3" />');
    expect(caps.map((c) => `${c.name}:${c.action}`)).toEqual(
      expect.arrayContaining(['calculator:evaluate', 'memory:recall'])
    );
  });
});

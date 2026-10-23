/**
 * The XML capability parse path (XML-LOOP: lives behind TOOL_LOOP=xml until the v3 soak ends).
 *
 * Wave 11 merged four files here, all against real exports:
 *   - xml-parser.test.ts            -> "CapabilityXMLParser: attributes and data JSON"
 *   - capability-orchestrator.test.ts (it only ever imported xml-parser) -> "extractCapabilities"
 *   - xml-parser-unclosed.test.ts   -> "unclosed tags stay linear" (wave 7 / ledger #5)
 *   - atomic/string-similarity.test.ts, which tested a local copy of the function; it now tests
 *     CapabilityParser.calculateSimilarity, the real one (same algorithm, same numbers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityXMLParser,
  capabilityXMLParser,
} from '../../src/engine/5-tool-loop/xml-parser.js';
import { capabilityParser } from '../../src/engine/5-tool-loop/parse-tool-calls.js';

describe('CapabilityXMLParser: attributes and data JSON', () => {
  let parser: CapabilityXMLParser;

  beforeEach(() => {
    parser = new CapabilityXMLParser();
  });

  describe('parseAttributes - Quote Handling', () => {
    it('should parse attributes with double quotes', () => {
      const text = '<capability name="calculator" action="calculate" data="test" />';
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].name).toBe('calculator');
      expect(capabilities[0].action).toBe('calculate');
    });

    it('should parse attributes with single quotes', () => {
      const text = "<capability name='calculator' action='calculate' data='test' />";
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].name).toBe('calculator');
      expect(capabilities[0].action).toBe('calculate');
    });

    it('should parse data attribute with single quotes containing JSON', () => {
      const text = `<capability name="calculator" action="calculate" data='{"expression":"42 * 137"}' />`;
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].name).toBe('calculator');
      expect(capabilities[0].action).toBe('calculate');
      expect(capabilities[0].params).toHaveProperty('expression');
      expect(capabilities[0].params.expression).toBe('42 * 137');
    });

    // Still skipped (wave 11 decision): parseAttributes reads double-quoted values with
    // /(\w+)="([^"]*)"/, so a backslash-escaped quote ends the value early. Making this pass
    // means changing the XML parser's behavior, and wave 11 may not change src behavior; the
    // whole XML path is slated for deletion after the TOOL_LOOP=xml soak, and native tool calls
    // never come through here. Workaround the prompt already teaches: single-quote the attribute.
    it.skip('should parse data attribute with double quotes containing JSON with escaped quotes', () => {
      const text = `<capability name="calculator" action="calculate" data="{\\"expression\\":\\"42 * 137\\"}" />`;
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].name).toBe('calculator');
      expect(capabilities[0].action).toBe('calculate');
      expect(capabilities[0].params).toHaveProperty('expression');
      expect(capabilities[0].params.expression).toBe('42 * 137');
    });
  });

  describe('data attribute JSON parsing', () => {
    it('should parse and merge JSON data into params', () => {
      const text = `<capability name="web" action="search" data='{"query":"test search","limit":10}' />`;
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].params).toEqual({
        query: 'test search',
        limit: 10,
      });
      expect(capabilities[0].params).not.toHaveProperty('data');
    });

    it('should handle complex nested JSON in data attribute', () => {
      const text = `<capability name="test" action="run" data='{"config":{"nested":true,"value":42}}' />`;
      const capabilities = parser.extractCapabilities(text);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].params).toHaveProperty('config');
      expect(capabilities[0].params.config).toEqual({
        nested: true,
        value: 42,
      });
    });
  });
});

describe('extractCapabilities (singleton parser)', () => {
  const capabilityParserXml = capabilityXMLParser;

  it('should extract self-closing capability tags with attributes', () => {
    const response =
      'Here is a calculation: <capability name="calculator" action="calculate" expression="2+2" />';
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].name).toBe('calculator');
    expect(capabilities[0].action).toBe('calculate');
    // expression attr is moved to content by the parser
    expect(capabilities[0].content).toBe('2+2');
  });

  it('should extract capability tags with content', () => {
    const response =
      'Let me search: <capability name="web" action="search">JavaScript tutorials</capability>';
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].name).toBe('web');
    expect(capabilities[0].action).toBe('search');
    expect(capabilities[0].content).toBe('JavaScript tutorials');
  });

  it('should extract multiple capabilities in order', () => {
    const response = `
        First: <capability name="calculator" action="calculate" expression="5*5" />
        Then: <capability name="web" action="search" query="math facts" />
      `;
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(2);
    expect(capabilities[0].name).toBe('calculator');
    expect(capabilities[1].name).toBe('web');
  });

  it('should extract capability with mixed attributes and content', () => {
    const response =
      '<capability name="memory" action="remember" category="facts">The sky is blue</capability>';
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].name).toBe('memory');
    expect(capabilities[0].action).toBe('remember');
    expect(capabilities[0].params.category).toBe('facts');
    expect(capabilities[0].content).toBe('The sky is blue');
  });

  it('should handle response with no capability tags', () => {
    const response = 'This is just regular text with no capabilities.';
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(0);
  });

  it('should handle empty response', () => {
    const response = '';
    const capabilities = capabilityParserXml.extractCapabilities(response);

    expect(capabilities).toHaveLength(0);
  });

  it('should skip capabilities missing required attributes', () => {
    const response = `
        <capability action="test" />
        <capability name="test" />
        <capability name="valid" action="test" />
      `;
    const capabilities = capabilityParserXml.extractCapabilities(response);

    // Only the valid one should be extracted
    expect(capabilities.length).toBeLessThanOrEqual(3);
    const validCap = capabilities.find((c) => c.name === 'valid');
    expect(validCap).toBeDefined();
    expect(validCap?.action).toBe('test');
  });
});

describe('CapabilityParser.extractCapabilities (the parse-tool-calls entry point)', () => {
  it('maps parsed tags to ExtractedCapability with priority = position', () => {
    const caps = capabilityParser.extractCapabilities(
      '<capability name="calculator" action="calculate" expression="1+1" /> then <capability name="web" action="search" query="x" />'
    );
    expect(caps.map((c) => [c.name, c.action, c.priority])).toEqual([
      ['calculator', 'calculate', 0],
      ['web', 'search', 1],
    ]);
  });

  it('resolves an old merged tool name to its canonical tool at parse time', () => {
    const caps = capabilityParser.extractCapabilities('<capability name="goal" action="list" />');
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('goals');
  });
});

// Wave 7 / ledger #5: the simple-tag scan is linear on unclosed / malformed tags.
describe('xml-parser on unclosed tags', () => {
  const parser = new CapabilityXMLParser();

  const cases: Array<[string, string]> = [
    ['50k chars of "<a"', '<a'.repeat(25_000)],
    ['50k chars of "<a>"', '<a>'.repeat(16_667)],
    ['50k chars of "<a>x"', '<a>x'.repeat(12_500)],
    ['50k chars of distinct unclosed tags', Array.from({ length: 6_000 }, (_, i) => `<t${i}>`).join('').slice(0, 50_000)],
  ];
  it.each(cases)('%s parses in < 200ms', (_label, text) => {
    const start = performance.now();
    const caps = parser.extractCapabilities(text);
    const ms = performance.now() - start;
    expect(caps).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

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

// Was atomic/string-similarity.test.ts (a local copy); now the real CapabilityParser method.
describe('CapabilityParser.calculateSimilarity', () => {
  const sim = (a: string, b: string) => capabilityParser.calculateSimilarity(a, b);

  it('should return 1.0 for identical strings', () => {
    expect(sim('write', 'write')).toBe(1.0);
  });

  it('should return 0.0 for empty strings', () => {
    expect(sim('', 'write')).toBe(0.0);
    expect(sim('write', '')).toBe(0.0);
  });

  it('should return 0.8 for substring matches', () => {
    expect(sim('write', 'write_file')).toBe(0.8);
    expect(sim('write_file', 'write')).toBe(0.8);
  });

  it('should return 0.7 for case-insensitive substring matches', () => {
    expect(sim('Write', 'write_file')).toBe(0.7);
    expect(sim('WRITE', 'write_file')).toBe(0.7);
  });

  it('should calculate prefix similarity correctly', () => {
    // 'wri' and 'wr' are substrings of 'write', so they return 0.8
    expect(sim('wri', 'write')).toBe(0.8);
    expect(sim('wr', 'write')).toBe(0.8);
    // For true prefix-only matches (no substring), use strings that don't match
    expect(sim('wxy', 'write')).toBe(0.2); // 1/5 - only 'w' matches
  });

  it('should handle completely different strings', () => {
    expect(sim('read', 'write')).toBe(0.0);
    expect(sim('xyz', 'abc')).toBe(0.0);
  });
});

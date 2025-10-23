import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityXMLParser } from '../utils/xml-parser.js';

describe('CapabilityXMLParser', () => {
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

    it('should parse data attribute with double quotes containing JSON with escaped quotes', () => {
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
        limit: 10
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
        value: 42
      });
    });
  });
});

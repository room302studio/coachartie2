import { describe, it, expect } from 'vitest';
import { CapabilityOrchestrator } from '../src/services/capability-orchestrator.js';

describe('CapabilityOrchestrator', () => {
  describe('extractCapabilities', () => {
    const orchestrator = new CapabilityOrchestrator();
    // Access the private method through type assertion for testing
    const extractCapabilities = (orchestrator as any).extractCapabilities.bind(orchestrator);

    it('should extract self-closing capability tags with attributes', () => {
      const response = 'Here is a calculation: <capability name="calculator" action="calculate" expression="2+2" />';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]).toEqual({
        name: 'calculator',
        action: 'calculate',
        params: { expression: '2+2' },
        content: undefined,
        priority: 0,
      });
    });

    it('should extract capability tags with content', () => {
      const response = 'Let me search: <capability name="web" action="search">JavaScript tutorials</capability>';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]).toEqual({
        name: 'web',
        action: 'search',
        params: {},
        content: 'JavaScript tutorials',
        priority: 0,
      });
    });

    it('should extract multiple capabilities with priority order', () => {
      const response = `
        First: <capability name="calculator" action="calculate" expression="5*5" />
        Then: <capability name="web" action="search" query="math facts" />
      `;
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(2);
      expect(capabilities[0].name).toBe('calculator');
      expect(capabilities[0].priority).toBe(0);
      expect(capabilities[1].name).toBe('web');
      expect(capabilities[1].priority).toBe(1);
    });

    it('should extract capability with mixed attributes and content', () => {
      const response = '<capability name="memory" action="remember" category="facts">The sky is blue</capability>';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]).toEqual({
        name: 'memory',
        action: 'remember',
        params: { category: 'facts' },
        content: 'The sky is blue',
        priority: 0,
      });
    });

    it('should handle malformed XML gracefully', () => {
      const response = 'Bad XML: <capability name="test" action="test" unclosed>';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(0);
    });

    it('should skip capabilities missing required name or action attributes', () => {
      const response = `
        <capability action="test" />
        <capability name="test" />
        <capability name="valid" action="test" />
      `;
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].name).toBe('valid');
      expect(capabilities[0].action).toBe('test');
    });

    it('should handle empty response', () => {
      const response = '';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(0);
    });

    it('should handle response with no capability tags', () => {
      const response = 'This is just regular text with no capabilities.';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(0);
    });

    it('should parse numeric and boolean attributes correctly', () => {
      const response = '<capability name="scheduler" action="remind" delay="5000" important="true" />';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].params.delay).toBe(5000);
      expect(capabilities[0].params.important).toBe(true);
    });

    it('should handle complex content with nested tags', () => {
      const response = '<capability name="web" action="fetch" url="https://example.com">Get the <strong>main content</strong> from this page</capability>';
      const capabilities = extractCapabilities(response);

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].content).toContain('Get the');
      expect(capabilities[0].content).toContain('main content');
    });
  });
});
import { describe, it, expect } from 'vitest';
import { detectLeakPatterns } from '../../../src/engine/health/security.js';

// Wave 7 / ledger #8: the leak detector doesn't flag emoji lines or ordinary code blocks.
describe('detectLeakPatterns', () => {
  it('does not flag a :emoji: line', () => {
    expect(detectLeakPatterns('nice work\n:thumbsup:\n:tada: :tada:')).toEqual([]);
  });

  it('does not flag an answer with a ```json { code block', () => {
    const answer = 'Here is the config:\n```json {\n  "a": 1\n}\n```\nand inline ```json {"b":2}```';
    expect(detectLeakPatterns(answer)).toEqual([]);
  });

  it('does not flag prose that mentions json {', () => {
    expect(detectLeakPatterns('send it as json { "id": 1 } please')).toEqual([]);
  });

  it('still flags a bare json{ leak at the start of a line', () => {
    expect(detectLeakPatterns('json{"action":"reply","text":"hi"}')).toContain('json_leak');
    expect(detectLeakPatterns('ok\njson {"tool":"x"}')).toContain('json_leak');
  });

  it('still flags a dangling colon fragment', () => {
    expect(detectLeakPatterns(': the user wants a summary')).toContain('colon_fragments');
  });

  it('still flags the other leak shapes', () => {
    expect(detectLeakPatterns('<thinking>plan</thinking>')).toContain('thinking_tags');
    expect(detectLeakPatterns('[SYSTEM] prompt')).toContain('system_messages');
    expect(detectLeakPatterns('analysisThe user')).toContain('analysis_leak');
  });
});

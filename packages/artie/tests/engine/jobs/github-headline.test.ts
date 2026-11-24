import { describe, it, expect } from 'vitest';
import { buildHeadlinePrompt, cleanHeadline, headlineModel } from '../../../src/engine/jobs/github-headline.js';

describe('github headline', () => {
  it('cleans a model reply to one plain line', () => {
    expect(cleanHeadline('"City downloads fall back to TCP; 8 fixes."\nextra')).toBe(
      'City downloads fall back to TCP; 8 fixes'
    );
    expect(cleanHeadline('Summary: Tunnel snap fixed')).toBe('Tunnel snap fixed');
    expect(cleanHeadline('')).toBeNull();
    expect(cleanHeadline('ok')).toBeNull();
    expect(cleanHeadline('x'.repeat(300))?.length).toBe(110);
  });

  it('strips HTML comments from PR templates and caps the body', () => {
    const p = buildHeadlinePrompt({ key: 'k', kind: 'pull request', title: 'T', body: `<!-- template -->real ${'y'.repeat(5000)}` });
    expect(p).not.toContain('template');
    expect(p.length).toBeLessThan(3500);
    expect(p).toContain('Title: T');
  });

  it('defaults to the cheap digest model', () => {
    expect(headlineModel({})).toBe('deepseek/deepseek-v4-flash-0731');
    expect(headlineModel({ HEADLINE_MODEL: 'x/y' })).toBe('x/y');
  });
});

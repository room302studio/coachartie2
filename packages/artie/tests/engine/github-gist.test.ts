import { describe, it, expect } from 'vitest';
import { buildGistPrompt, cleanGist, gistModel } from '../../src/engine/jobs/github-gist.js';

describe('github gist', () => {
  it('cleans a model reply to one plain line', () => {
    expect(cleanGist('"City downloads fall back to TCP; 8 fixes."\nextra')).toBe(
      'City downloads fall back to TCP; 8 fixes'
    );
    expect(cleanGist('Summary: Tunnel snap fixed')).toBe('Tunnel snap fixed');
    expect(cleanGist('')).toBeNull();
    expect(cleanGist('ok')).toBeNull();
    expect(cleanGist('x'.repeat(300))?.length).toBe(110);
  });

  it('strips HTML comments from PR templates and caps the body', () => {
    const p = buildGistPrompt({ key: 'k', kind: 'pull request', title: 'T', body: `<!-- template -->real ${'y'.repeat(5000)}` });
    expect(p).not.toContain('template');
    expect(p.length).toBeLessThan(3500);
    expect(p).toContain('Title: T');
  });

  it('defaults to the cheap digest model', () => {
    expect(gistModel({})).toBe('deepseek/deepseek-v4-flash-0731');
    expect(gistModel({ GIST_MODEL: 'x/y' })).toBe('x/y');
  });
});

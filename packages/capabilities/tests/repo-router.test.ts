import { describe, it, expect } from 'vitest';
import { buildRoutePrompt, parseRoutePick } from '../src/services/core/repo-router.js';

const channels = [
  { id: '111', name: 'subwaybuilder-engineering', category: 'Subway Builder', topic: 'code, PRs, CI' },
  { id: '222', name: 'subwaybuilder-leadership', category: 'Subway Builder' },
  { id: '333', name: '🤖robot', category: 'Studio' },
];

describe('repo router', () => {
  it('accepts a pick only if it is one of the offered channels', () => {
    expect(parseRoutePick('{"channelId":"111","reason":"engineering work"}', channels)).toEqual({ channelId: '111', reason: 'engineering work' });
    expect(parseRoutePick('sure! {"channelId": "999", "reason": "made up"}', channels)).toBeNull();
    expect(parseRoutePick('#subwaybuilder-engineering', channels)).toBeNull();
    expect(parseRoutePick('{"channelId": "<#111>"}', channels)?.channelId).toBe('111');
  });

  it('shows the model the repo, every channel and the existing routing pattern', () => {
    const p = buildRoutePrompt(
      { fullName: 'Subway-Builder/sb-unity', description: 'Unity port', language: 'C#' },
      channels,
      [{ repo: 'Subway-Builder/metro-maker4', channel: 'subwaybuilder-engineering' }]
    );
    expect(p).toContain('Subway-Builder/sb-unity');
    expect(p).toContain('Unity port');
    expect(p).toContain('111 #subwaybuilder-engineering (category: Subway Builder) — code, PRs, CI');
    expect(p).toContain('metro-maker4 → #subwaybuilder-engineering');
  });
});

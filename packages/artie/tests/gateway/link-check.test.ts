import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'nowhere.invalid-example.com') throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    if (host === 'internal.example.com') return { address: '10.0.0.5', family: 4 };
    return { address: '93.184.216.34', family: 4 };
  }),
}));

const { stripDeadLinks, DEAD_LINK_NOTE } = await import('../../src/gateway/4-reply/link-check.js');

describe('stripDeadLinks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes a bare invented page, keeps live and merely-flaky ones', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/whatsnew')) return new Response('', { status: 404 });
      if (url.includes('flaky')) return new Response('', { status: 503 });
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { text, removed } = await stripDeadLinks(
      "Check **subwaybuilder.com/whatsnew**, or https://subwaybuilder.com/changelog. Status: https://flaky.example.com/x"
    );
    expect(removed).toEqual(['subwaybuilder.com/whatsnew']);
    expect(text).toBe(`Check **${DEAD_LINK_NOTE}**, or https://subwaybuilder.com/changelog. Status: https://flaky.example.com/x`);
  });

  it('keeps markdown link text when the URL is dead, and drops unresolvable hosts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 410 })));
    const { text } = await stripDeadLinks('See [the notes](https://example.com/gone) and https://nowhere.invalid-example.com/a');
    expect(text).toBe(`See the notes and ${DEAD_LINK_NOTE}`);
  });

  it('never fetches private addresses or Discord links', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = 'https://internal.example.com/admin https://discord.com/channels/1/2/3 http://127.0.0.1:47324/chat';
    expect((await stripDeadLinks(input)).text).toBe(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves text without links untouched and makes no requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await stripDeadLinks('no links here, file.ts is fine')).removed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

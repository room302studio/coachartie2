import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'attachment-scope-')), 'test.db');
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dummy';

const visionHandler = vi.fn(async () => 'a photo of a dock');
vi.mock('../../../../src/engine/capabilities/media/vision.js', () => ({
  visionCapability: { handler: visionHandler },
}));

const { splitAttachments, addAttachmentContext } = await import(
  '../../../../src/engine/3-context/sources/attachments.js'
);

const img = (id: string, messageId: string, author = 'someone') => ({
  id,
  name: `${id}.png`,
  url: `https://cdn.example/${id}.png`,
  contentType: 'image/png',
  author,
  messageId,
  timestamp: new Date(Date.now() - 4 * 60000).toISOString(),
});

describe('splitAttachments', () => {
  it('keeps only current + replied-to attachments as addressed', () => {
    const current = [img('mine', 'm0', 'speaker')];
    const recent = [img('a', 'm1'), img('b', 'm2')];
    const { addressed, earlier } = splitAttachments(current, recent, 'm2');
    expect(addressed.map((a) => a.id)).toEqual(['mine', 'b']);
    expect(earlier.map((a) => a.id)).toEqual(['a']);
  });

  it('treats every recent attachment as earlier when not replying', () => {
    const { addressed, earlier } = splitAttachments([], [img('a', 'm1')], null);
    expect(addressed).toEqual([]);
    expect(earlier).toHaveLength(1);
  });

  it('drops earlier images behind a 45-minute lull or over an hour old', () => {
    const now = Date.now();
    const at = (id: string, minsAgo: number) => ({
      ...img(id, id),
      timestamp: new Date(now - minsAgo * 60000).toISOString(),
    });
    // 5m, 20m: same conversation. 70m: behind a 50m lull. Undated: unknowable, dropped.
    const recent = [at('old', 70), at('new', 5), at('mid', 20), { ...img('nodate', 'x'), timestamp: undefined }];
    const { earlier } = splitAttachments([], recent, null, now);
    expect(earlier.map((a) => a.id)).toEqual(['new', 'mid']);

    // Steady chatter still can't keep a 61-minute-old image alive.
    const chain = [at('a', 10), at('b', 40), at('c', 61)];
    expect(splitAttachments([], chain, null, now).earlier.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('keeps a replied-to image no matter how old', () => {
    const old = { ...img('ancient', 'm9'), timestamp: new Date(Date.now() - 5 * 3600_000).toISOString() };
    expect(splitAttachments([], [old], 'm9').addressed.map((a) => a.id)).toEqual(['ancient']);
  });
});

describe('addAttachmentContext', () => {
  beforeEach(() => visionHandler.mockClear());

  it("does not auto-run vision on other people's earlier images (applesauce/Sharpness bug)", async () => {
    const sources: any[] = [];
    await addAttachmentContext(
      {
        message: 'wtf is that supposed to mean',
        userId: 'u1',
        context: { recentAttachments: [img('dock', 'm1', 'otherperson')] },
      } as any,
      sources
    );
    expect(visionHandler).not.toHaveBeenCalled();
    expect(sources.find((s) => s.name === 'attachments_vision')).toBeUndefined();
    const listing = sources.find((s) => s.name === 'attachments')?.content ?? '';
    expect(listing).toContain('NOT attached to this message');
    expect(listing).toContain('by otherperson, 4m ago');
    expect(listing).not.toContain('Vision/OCR recommended');
  });

  it("runs vision on the speaker's own attachment and names the poster", async () => {
    const sources: any[] = [];
    await addAttachmentContext(
      {
        message: 'look at my line',
        userId: 'u1',
        context: { attachments: [img('mine', 'm0', 'speaker')], recentAttachments: [] },
      } as any,
      sources
    );
    expect(visionHandler).toHaveBeenCalledTimes(1);
    const vision = sources.find((s) => s.name === 'attachments_vision')?.content ?? '';
    expect(vision).toContain('(posted by speaker)');
  });

  it('runs vision on the image in the message being replied to', async () => {
    const sources: any[] = [];
    await addAttachmentContext(
      {
        message: 'what is this?',
        userId: 'u1',
        context: { replyingTo: 'm7', recentAttachments: [img('pic', 'm7', 'poster')] },
      } as any,
      sources
    );
    expect(visionHandler).toHaveBeenCalledTimes(1);
    const [{ urls }] = visionHandler.mock.calls[0] as any;
    expect(urls).toEqual(['https://cdn.example/pic.png']);
  });
});

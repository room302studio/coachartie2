import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Client } from 'discord.js';

// Throwaway DB for kv_state (the draft digest's day key) and identity mappings.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'gh-draft-')), 'test.db');

let watchLoop: typeof import('../../../../src/gateway/watchers/github/watch-loop.js');
let batcher: typeof import('../../../../src/gateway/watchers/github/event-batcher.js');

beforeAll(async () => {
  const { initializeDb } = await import('../../../../src/shared/db/client.js');
  initializeDb();
  watchLoop = await import('../../../../src/gateway/watchers/github/watch-loop.js');
  batcher = await import('../../../../src/gateway/watchers/github/event-batcher.js');
});

function service(): any {
  const svc: any = new watchLoop.GitHubSyncService({} as Client);
  svc.postDraftDigest = vi.fn(async () => undefined);
  return svc;
}

// 2026-11-03 is a Tuesday; EST (UTC-5) after the Nov 1 fall-back.
const TUE_0930_ET = new Date('2026-11-03T14:30:00Z');
const TUE_1030_ET = new Date('2026-11-03T15:30:00Z');
const WED_0905_ET = new Date('2026-11-04T14:05:00Z');
const SAT_0930_ET = new Date('2026-11-07T14:30:00Z');

describe('draft PR digest schedule (G6)', () => {
  it('posts once in the 9 AM ET hour, survives a restart, skips weekends', async () => {
    const a = service();
    await a.checkAndPostDraftDigest(TUE_1030_ET);
    expect(a.postDraftDigest).not.toHaveBeenCalled();

    await a.checkAndPostDraftDigest(TUE_0930_ET);
    await a.checkAndPostDraftDigest(TUE_0930_ET);
    expect(a.postDraftDigest).toHaveBeenCalledTimes(1);

    // A deploy inside the hour: the day key is in kv_state, not memory.
    const b = service();
    await b.checkAndPostDraftDigest(TUE_0930_ET);
    expect(b.postDraftDigest).not.toHaveBeenCalled();

    await b.checkAndPostDraftDigest(WED_0905_ET);
    expect(b.postDraftDigest).toHaveBeenCalledTimes(1);

    const c = service();
    await c.checkAndPostDraftDigest(SAT_0930_ET);
    expect(c.postDraftDigest).not.toHaveBeenCalled();
  });
});

describe('digest mode (G6)', () => {
  it('puts only the overflow in the digest, so no event posts twice', async () => {
    const svc: any = new watchLoop.GitHubSyncService({} as Client);
    svc.processor = new batcher.GitHubEventProcessor({ batchWindowMs: 60 * 60 * 1000 });
    svc.poster = { postBatch: vi.fn(async () => undefined) };
    const addToBatch = vi.spyOn(svc.processor, 'addToBatch');
    svc.postDigest = vi.fn(async () => undefined);

    for (let n = 1; n <= 7; n++) {
      await svc.handleEvent({
        type: 'pr_opened',
        repo: 'o/r',
        channelId: 'c',
        guildId: 'g',
        data: { prNumber: n, prAuthor: 'ej' },
        timestamp: '2026-11-03T14:30:00Z',
      });
    }
    await svc.endPollCycle();

    const batched = addToBatch.mock.calls.map((c: any) => c[0].event.data.prNumber);
    const digested = svc.postDigest.mock.calls[0][0].map((e: any) => e.data.prNumber);
    expect(batched).toEqual([1, 2, 3, 4, 5]);
    expect(digested).toEqual([6, 7]);
    await svc.stop(100);
  });
});

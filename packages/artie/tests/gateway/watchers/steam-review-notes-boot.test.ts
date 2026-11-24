/**
 * W24 (state-machine audit 2026-10-31): the watcher booted with analysisPending=true and
 * lastAnalysisAt=0, so every deploy forced a paid analysis rewrite (~32 of 38 refreshes were
 * boot noise). The pending flag and last-analysis time now live in kv_state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'steam-notes-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
const NOTES = join(dir, 'steam-review-notes.md');

const observe = vi.fn();

vi.mock('../../../src/engine/api.js', () => ({
  observe: (...args: unknown[]) => observe(...args),
  isOk: (r: { status: number }) => r.status < 400,
  statusText: () => '',
}));

vi.mock('../../../src/shared/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/paths.js')>()),
  getSteamReviewNotes: () => NOTES,
}));

const SEEDED = `<!-- cursor:100 -->

**Tally:** 👍 1 · 👎 0

## Situation Analysis

<!-- analysis:start -->
old analysis
<!-- analysis:end -->

## Review Log

<!-- log:start -->
- 2026-10-30 12:00 👍 (10 hrs, English): "good game"
<!-- log:end -->
`;

// A channel with nothing new since the cursor.
const quietClient = {
  channels: { fetch: async () => ({ messages: { fetch: async () => new Map() } }) },
};

// test-setup.ts points the shared client at :memory:; a fresh module graph opens the
// DATABASE_PATH file instead, which is what survives a "restart" here.
async function freshKv(): Promise<typeof import('../../../src/shared/db/kv-state.js')> {
  vi.resetModules();
  return import('../../../src/shared/db/kv-state.js');
}

/** A fresh process: new module instance, initialize(), then the first cycle. */
async function boot(): Promise<void> {
  vi.resetModules();
  const { steamReviewNotes } = await import('../../../src/gateway/watchers/steam-review-notes.js');
  steamReviewNotes.initialize(quietClient as never);
  steamReviewNotes.shutdown();
  await steamReviewNotes.runCycle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
  writeFileSync(NOTES, SEEDED, 'utf-8');
  observe.mockReset();
  observe.mockResolvedValue({ status: 200, body: { summary: 'fresh analysis', cost: 0.01 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('steam review analysis across restarts', () => {
  it('a boot with nothing new does not re-run the analysis', async () => {
    const kv = await freshKv();
    kv.writeState('steam-review-notes:analysis-pending', '0');
    kv.writeState('steam-review-notes:last-analysis-at', String(Date.now() - 3 * 3600_000));
    await boot();
    expect(observe).not.toHaveBeenCalled();
  });

  it('a refresh that was still pending before the restart runs after it', async () => {
    const kv = await freshKv();
    kv.writeState('steam-review-notes:analysis-pending', '1');
    kv.writeState('steam-review-notes:last-analysis-at', String(Date.now() - 3 * 3600_000));
    await boot();
    expect(observe).toHaveBeenCalledTimes(1);
    expect((await freshKv()).readState('steam-review-notes:analysis-pending')).toBe('0');
    // ...and the next boot does not repeat it
    observe.mockClear();
    await boot();
    expect(observe).not.toHaveBeenCalled();
  });
});

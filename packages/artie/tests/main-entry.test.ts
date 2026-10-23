/**
 * src/main.ts is the one entry point (wave 9): importing it calls boot() exactly once with
 * the default ready signal (process.send('ready'), covered in boot.test.ts) and installs one
 * SIGINT and one SIGTERM handler for the whole process. boot.js is mocked here; the handlers
 * main.ts adds are removed again afterwards so they can't act on this test worker.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

const bootMock = vi.hoisted(() => ({
  boot: vi.fn(async () => ({ ready: true })),
  shutdown: vi.fn(async () => {}),
}));
vi.mock('../src/boot.js', () => bootMock);

const EVENTS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
const before = Object.fromEntries(EVENTS.map((e) => [e, process.listeners(e as any)]));

describe('src/main.ts', () => {
  afterAll(() => {
    for (const e of EVENTS) {
      for (const l of process.listeners(e as any)) {
        if (!before[e].includes(l)) process.removeListener(e, l as any);
      }
    }
  });

  it('boots once and installs exactly one SIGINT and one SIGTERM handler', async () => {
    await import('../src/main.js');
    expect(bootMock.boot).toHaveBeenCalledTimes(1);
    expect(bootMock.boot).toHaveBeenCalledWith(); // default notifyReady = process.send('ready')
    const added = (e: string) =>
      process.listeners(e as any).filter((l) => !before[e].includes(l)).length;
    expect(added('SIGINT')).toBe(1);
    expect(added('SIGTERM')).toBe(1);
    expect(bootMock.shutdown).not.toHaveBeenCalled();
  });
});

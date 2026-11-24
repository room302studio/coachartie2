/**
 * W15 (state-machine audit 2026-10-31): pending attachments were keyed by userId with no TTL and
 * drained only when a reply succeeded, so a failed turn's image landed on that person's next,
 * unrelated reply. Now keyed by turn id with a 10-minute TTL, like pending-components.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  addPendingAttachment,
  getPendingAttachments,
  type PendingAttachment,
} from '../../../src/engine/1-intake/pending-attachments.js';

function file(name: string): PendingAttachment {
  return { buffer: Buffer.from(name), filename: name };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pending-attachments store', () => {
  it("a failed turn's file does not ride on the same person's next turn", () => {
    addPendingAttachment('turn-failed', file('orphan.png'));
    // the next turn (a different turn id) takes only its own files
    addPendingAttachment('turn-next', file('mine.png'));
    expect(getPendingAttachments('turn-next').map((a) => a.filename)).toEqual(['mine.png']);
  });

  it('take clears, and a second add for the same turn appends', () => {
    addPendingAttachment('turn-append', file('a.png'));
    addPendingAttachment('turn-append', file('b.png'));
    expect(getPendingAttachments('turn-append').map((a) => a.filename)).toEqual(['a.png', 'b.png']);
    expect(getPendingAttachments('turn-append')).toEqual([]);
  });

  it('drops an attachment with no turn id', () => {
    addPendingAttachment('', file('nowhere.png'));
    expect(getPendingAttachments('')).toEqual([]);
  });

  it('expires after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    addPendingAttachment('turn-ttl', file('late.png'));
    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(getPendingAttachments('turn-ttl')).toEqual([]);
  });

  it('send-metro-file queues under the turn id, not the user id', async () => {
    const { sendMetroFileCapability } = await import(
      '../../../src/engine/capabilities/discord/send-metro-file.js'
    );
    const { storeAnalyzedMetroFile } = await import(
      '../../../src/engine/1-intake/pending-attachments.js'
    );
    storeAnalyzedMetroFile('metro-user', 'city.metro', Buffer.from('x'), 'summary');
    await sendMetroFileCapability.handler({ action: 'send', userId: 'metro-user' }, undefined, {
      userId: 'metro-user',
      messageId: 'turn-metro',
    });
    expect(getPendingAttachments('metro-user')).toEqual([]);
    expect(getPendingAttachments('turn-metro').map((a) => a.filename)).toEqual(['city.metro']);
  });

  it('does not expire just before the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    addPendingAttachment('turn-fresh', file('ok.png'));
    vi.setSystemTime(10 * 60 * 1000 - 1);
    expect(getPendingAttachments('turn-fresh')).toHaveLength(1);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  addPendingComponents,
  takePendingComponents,
  type PendingComponentRow,
} from '../../src/engine/1-intake/pending-components.js';

const ROW: PendingComponentRow = { type: 1, components: [{ type: 2, label: 'Yes' }] };

afterEach(() => {
  vi.useRealTimers();
});

describe('pending-components store', () => {
  it('take returns [] when nothing was queued for the turn', () => {
    expect(takePendingComponents('no-such-turn')).toEqual([]);
  });

  it('round-trips rows queued for a turn', () => {
    addPendingComponents('turn-1', [ROW]);
    expect(takePendingComponents('turn-1')).toEqual([ROW]);
  });

  it('take clears the entry — a second take for the same turn is empty', () => {
    addPendingComponents('turn-2', [ROW]);
    expect(takePendingComponents('turn-2')).toEqual([ROW]);
    expect(takePendingComponents('turn-2')).toEqual([]);
  });

  it('two different turn ids never see each other\'s rows', () => {
    const rowA: PendingComponentRow = { type: 1, components: [{ type: 2, label: 'A' }] };
    const rowB: PendingComponentRow = { type: 1, components: [{ type: 2, label: 'B' }] };
    addPendingComponents('turn-a', [rowA]);
    addPendingComponents('turn-b', [rowB]);
    expect(takePendingComponents('turn-a')).toEqual([rowA]);
    expect(takePendingComponents('turn-b')).toEqual([rowB]);
  });

  it('a second addPendingComponents for the same turn APPENDS, not overwrites', () => {
    const rowA: PendingComponentRow = { type: 1, components: [{ type: 2, label: 'A' }] };
    const rowB: PendingComponentRow = { type: 1, components: [{ type: 2, label: 'B' }] };
    addPendingComponents('turn-append', [rowA]);
    addPendingComponents('turn-append', [rowB]);
    expect(takePendingComponents('turn-append')).toEqual([rowA, rowB]);
  });

  it('clamps the combined total to 5 rows (Discord\'s per-message limit)', () => {
    const rows = (n: number): PendingComponentRow[] =>
      Array.from({ length: n }, (_, i) => ({ type: 1, components: [{ type: 2, label: `r${i}` }] }));
    addPendingComponents('turn-clamp', rows(3));
    addPendingComponents('turn-clamp', rows(4)); // 3 + 4 = 7, clamp to 5
    expect(takePendingComponents('turn-clamp')).toHaveLength(5);
  });

  it('ignores an empty rows array (nothing to queue)', () => {
    addPendingComponents('turn-empty', []);
    expect(takePendingComponents('turn-empty')).toEqual([]);
  });

  it('ignores a falsy turn id', () => {
    addPendingComponents('', [ROW]);
    expect(takePendingComponents('')).toEqual([]);
  });

  it('expires after the TTL — a take past 10 minutes is empty', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    addPendingComponents('turn-ttl', [ROW]);
    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(takePendingComponents('turn-ttl')).toEqual([]);
  });

  it('does not expire just before the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    addPendingComponents('turn-fresh', [ROW]);
    vi.setSystemTime(10 * 60 * 1000 - 1);
    expect(takePendingComponents('turn-fresh')).toEqual([ROW]);
  });
});

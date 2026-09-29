import { describe, it, expect, vi } from 'vitest';
import {
  reportToAnomalywatch,
  createMemoryAlertRateStore,
  sqliteAlertRateStore,
  flattenAlertMessage,
  isOperatorOnlyError,
} from '../src/utils/anomalywatch.js';

describe('reportToAnomalywatch', () => {
  const at = (iso: string) => new Date(iso);

  it('sends via alert.sh with source coach-artie, level and a flattened message', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const outcome = await reportToAnomalywatch('warning', '**Balance low**\n$3.00', {
      kind: 'low',
      store: createMemoryAlertRateStore(),
      scriptPath: '/fake/alert.sh',
      exec,
      now: at('2026-09-29T15:00:00Z'),
    });
    expect(outcome).toBe('sent');
    expect(exec).toHaveBeenCalledWith(
      '/fake/alert.sh',
      ['coach-artie', 'warning', 'Balance low $3.00'],
      undefined
    );
  });

  it('passes alert type and deep link to alert.sh as env', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await reportToAnomalywatch('warning', 'DM pairing request: stranger', {
      kind: 'dm-pairing:1',
      store: createMemoryAlertRateStore(),
      scriptPath: '/fake/alert.sh',
      exec,
      alertType: 'dm_pairing_request',
      deepLink: 'https://discord.com/users/1',
    });
    expect(exec.mock.calls[0][2]).toEqual({
      ALERT_TYPE: 'dm_pairing_request',
      ALERT_DEEPLINK: 'https://discord.com/users/1',
    });
  });

  it('rate-limits to once per kind per ET day', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryAlertRateStore();
    const opts = { kind: 'budget', store, scriptPath: '/fake/alert.sh', exec };

    expect(await reportToAnomalywatch('warning', 'a', { ...opts, now: at('2026-09-29T13:00:00Z') })).toBe('sent');
    expect(await reportToAnomalywatch('warning', 'b', { ...opts, now: at('2026-09-29T20:00:00Z') })).toBe('rate-limited');
    // 03:59Z on the 30th is still 23:59 on the 29th in New York (EDT, UTC-4).
    expect(await reportToAnomalywatch('warning', 'c', { ...opts, now: at('2026-09-30T03:59:00Z') })).toBe('rate-limited');
    // 04:00Z on the 30th is ET midnight — a new day.
    expect(await reportToAnomalywatch('warning', 'd', { ...opts, now: at('2026-09-30T04:00:00Z') })).toBe('sent');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('limits each kind independently', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const store = createMemoryAlertRateStore();
    const now = at('2026-09-29T13:00:00Z');
    const base = { store, scriptPath: '/fake/alert.sh', exec, now };
    expect(await reportToAnomalywatch('warning', 'x', { ...base, kind: 'vitals' })).toBe('sent');
    expect(await reportToAnomalywatch('warning', 'x', { ...base, kind: 'distress' })).toBe('sent');
    expect(await reportToAnomalywatch('warning', 'x', { ...base, kind: 'vitals' })).toBe('rate-limited');
  });

  it('only logs when alert.sh does not exist, and still counts against the day', async () => {
    const exec = vi.fn();
    const store = createMemoryAlertRateStore();
    const opts = { kind: 'k', store, scriptPath: null, exec, now: at('2026-09-29T13:00:00Z') };
    expect(await reportToAnomalywatch('warning', 'm', opts)).toBe('logged');
    expect(await reportToAnomalywatch('warning', 'm', opts)).toBe('rate-limited');
    expect(exec).not.toHaveBeenCalled();
  });

  it('never throws when the script fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('boom'));
    const outcome = await reportToAnomalywatch('error', 'm', {
      kind: 'k',
      store: createMemoryAlertRateStore(),
      scriptPath: '/fake/alert.sh',
      exec,
    });
    expect(outcome).toBe('failed');
  });

  it('releases the day after a failed send so a retry can get through', async () => {
    const store = createMemoryAlertRateStore();
    const base = { kind: 'k', store, scriptPath: '/fake/alert.sh', now: new Date('2026-09-29T13:00:00Z') };
    expect(await reportToAnomalywatch('error', 'm', { ...base, exec: vi.fn().mockRejectedValue(new Error('x')) })).toBe('failed');
    expect(await reportToAnomalywatch('error', 'm', { ...base, exec: vi.fn().mockResolvedValue(undefined) })).toBe('sent');
  });

  it('persists the rate limit in SQLite (survives a process restart)', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const kind = `sqlite-test-${Math.random()}`;
    const now = at('2026-09-29T13:00:00Z');
    const opts = { kind, store: sqliteAlertRateStore, scriptPath: '/fake/alert.sh', exec, now };
    expect(await reportToAnomalywatch('warning', 'm', opts)).toBe('sent');
    expect(sqliteAlertRateStore.lastDay(kind)).toBe('2026-09-29');
    expect(await reportToAnomalywatch('warning', 'm', opts)).toBe('rate-limited');
  });
});

describe('flattenAlertMessage', () => {
  it('strips markdown, collapses whitespace and bounds length', () => {
    expect(flattenAlertMessage('**a**\n\n`b`  c')).toBe('a b c');
    expect(flattenAlertMessage('x'.repeat(600)).length).toBe(500);
  });
});

describe('isOperatorOnlyError', () => {
  it('flags billing, credit, budget and mute failures', () => {
    expect(isOperatorOnlyError('💳 OUT OF CREDITS: OpenRouter account needs more credits.')).toBe(true);
    expect(isOperatorOnlyError(new Error('HTTP 402 Payment Required'))).toBe(true);
    expect(isOperatorOnlyError('🔇 GENERATION MUTED (daily budget)')).toBe(true);
  });
  it('leaves ordinary failures alone', () => {
    expect(isOperatorOnlyError('Global job timeout after 180s')).toBe(false);
  });
});

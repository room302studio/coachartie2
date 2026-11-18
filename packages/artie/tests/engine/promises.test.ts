/**
 * Promises (Artie's request 2026-11-17): what he told someone he'd do, shown when they talk
 * to him next. The privacy-critical direction is DM to server: a DM promise must never show,
 * be listed, or be closed (which echoes its text) inside a server.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getSyncDb, initializeDb } from '../../src/shared/db/client.js';
import {
  addPromise,
  listOpenPromises,
  resetPromiseStoreState,
  MAX_OPEN_PER_PERSON,
  PROMISE_WINDOW_DAYS,
} from '../../src/shared/db/promise-store.js';
import { promisesCapability } from '../../src/engine/tools/core/promises.js';
import { promisesLine } from '../../src/engine/3-context/sources/last-time.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';

const DAY = 24 * 60 * 60 * 1000;

function call(params: Record<string, unknown>, ctx: Record<string, unknown> | undefined): Promise<string> {
  return promisesCapability.handler(params as any, undefined, ctx as any) as Promise<string>;
}

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  resetPromiseStoreState();
  listOpenPromises('warmup', null); // creates the table
  getSyncDb().exec('DELETE FROM artie_promises');
});

describe('promise store scope', () => {
  it('a DM promise never shows in a server; a server promise shows only in that server', () => {
    addPromise({ userId: 'u1', guildId: null, channelId: 'dm1', text: 'private dm thing' });
    addPromise({ userId: 'u1', guildId: 'gA', channelId: 'c1', text: 'server A thing' });
    addPromise({ userId: 'u1', guildId: 'gB', channelId: 'c2', text: 'server B thing' });

    expect(listOpenPromises('u1', 'gA').map((p) => p.text)).toEqual(['server A thing']);
    expect(listOpenPromises('u1', 'gB').map((p) => p.text)).toEqual(['server B thing']);
    // In their own DM they see all of theirs: they were there for each one.
    expect(listOpenPromises('u1', null)).toHaveLength(3);
    // Nobody else's.
    expect(listOpenPromises('u2', null)).toHaveLength(0);
  });

  it(`stops showing open promises older than ${PROMISE_WINDOW_DAYS} days`, () => {
    const now = Date.now();
    addPromise({ userId: 'u1', guildId: null, channelId: null, text: 'ancient' }, now - (PROMISE_WINDOW_DAYS + 1) * DAY);
    addPromise({ userId: 'u1', guildId: null, channelId: null, text: 'recent' }, now - DAY);
    expect(listOpenPromises('u1', null, now).map((p) => p.text)).toEqual(['recent']);
  });

  it('caps open promises per person and validates text', () => {
    for (let i = 0; i < MAX_OPEN_PER_PERSON; i++) {
      expect(addPromise({ userId: 'u1', guildId: null, channelId: null, text: `p${i}` }).ok).toBe(true);
    }
    expect(addPromise({ userId: 'u1', guildId: null, channelId: null, text: 'one more' }).ok).toBe(false);
    expect(addPromise({ userId: 'u2', guildId: null, channelId: null, text: '   ' }).ok).toBe(false);
    expect(addPromise({ userId: 'u2', guildId: null, channelId: null, text: 'x'.repeat(201) }).ok).toBe(false);
  });
});

describe('promises tool', () => {
  it('add takes who and where from the conversation, not params', async () => {
    const out = await call(
      { action: 'add', text: 'check on their map', userId: 'someone-else', guildId: 'gX' },
      { userId: 'u1', guildId: 'gA', channelId: 'c1' }
    );
    expect(out).toContain('✅');
    const rows = listOpenPromises('u1', 'gA');
    expect(rows).toHaveLength(1);
    expect(rows[0].guild_id).toBe('gA');
    expect(listOpenPromises('someone-else', null)).toHaveLength(0);
  });

  it('refuses with no caller', async () => {
    expect(await call({ action: 'add', text: 'x' }, undefined)).toContain('❌');
  });

  it('done closes your own; someone else cannot see or close it', async () => {
    const row = addPromise({ userId: 'u1', guildId: 'gA', channelId: 'c1', text: 'review the PR' });
    if (!row.ok) throw new Error('setup');
    const id = `P${row.row.id}`;
    const other = await call({ action: 'done', id }, { userId: 'u2', guildId: 'gA' });
    expect(other).toContain("don't see");
    expect(other).not.toContain('review the PR');
    const mine = await call({ action: 'done', id }, { userId: 'u1', guildId: 'gA' });
    expect(mine).toContain('done');
    expect(listOpenPromises('u1', 'gA')).toHaveLength(0);
    expect(await call({ action: 'drop', id }, { userId: 'u1', guildId: 'gA' })).toContain("don't see");
  });

  it('a DM promise cannot be listed or closed from a server, not even by the owner', async () => {
    const row = addPromise({ userId: OWNER_USER_ID, guildId: null, channelId: 'dm', text: 'secret dm promise' });
    if (!row.ok) throw new Error('setup');
    const id = `P${row.row.id}`;
    const listed = await call({ action: 'list' }, { userId: OWNER_USER_ID, guildId: 'gA' });
    expect(listed).not.toContain('secret dm promise');
    const closed = await call({ action: 'drop', id }, { userId: OWNER_USER_ID, guildId: 'gA' });
    expect(closed).not.toContain('secret dm promise');
    expect(listOpenPromises(OWNER_USER_ID, null)).toHaveLength(1);
    // From the DM it works.
    expect(await call({ action: 'drop', id }, { userId: OWNER_USER_ID })).toContain('dropped');
  });

  it('the owner can close a promise made in this server to someone else', async () => {
    const row = addPromise({ userId: 'u1', guildId: 'gA', channelId: 'c1', text: 'fix the tiles' });
    if (!row.ok) throw new Error('setup');
    expect(await call({ action: 'done', id: row.row.id }, { userId: OWNER_USER_ID, guildId: 'gA' })).toContain('done');
  });
});

describe('promisesLine', () => {
  it('shows up to three, oldest first, with a pointer to the rest', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const t = now.getTime();
    const open = [1, 2, 3, 4].map((n) => ({ id: n, text: `thing ${n}`, created_at: t - (5 - n) * DAY }));
    const line = promisesLine(open, now);
    expect(line).toContain('P1 thing 1 (4d ago)');
    expect(line).toContain('P3 thing 3');
    expect(line).not.toContain('P4');
    expect(line).toContain('+1 more');
  });

  it('is null with nothing open', () => {
    expect(promisesLine([])).toBeNull();
  });
});

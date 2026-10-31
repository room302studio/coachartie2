import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tool-exposure-')), 'test.db');

let exposure: typeof import('../../src/engine/2-turn/tool-exposure.js');
let db: ReturnType<typeof import('../../src/shared/db/client.js').getSyncDb>;

const now = () => new Date().toISOString();
const tool = (name: string) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

beforeAll(async () => {
  const { getSyncDb } = await import('../../src/shared/db/client.js');
  db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS generation_traces (id TEXT PRIMARY KEY, message_id TEXT, user_id TEXT, channel_id TEXT, started_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS capability_invocations (id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT, capability_name TEXT NOT NULL, action TEXT NOT NULL, started_at TEXT NOT NULL)`);
  db.run(`INSERT INTO generation_traces (id, message_id, user_id, channel_id, started_at) VALUES ('t1', 'm0', 'u', 'chan-a', ?)`, [now()]);
  for (let i = 0; i < 5; i++) {
    db.run(`INSERT INTO capability_invocations (trace_id, capability_name, action, started_at) VALUES ('t0', 'web', 'search', ?)`, [now()]);
  }
  db.run(`INSERT INTO capability_invocations (trace_id, capability_name, action, started_at) VALUES ('t1', 'tts', 'speak', ?)`, [now()]);
  db.run(`INSERT INTO capability_invocations (trace_id, capability_name, action, started_at) VALUES ('t0', 'osint', 'lookup', '2026-01-01T00:00:00.000Z')`);
  exposure = await import('../../src/engine/2-turn/tool-exposure.js');
});

describe('tool exposure shadow routers', () => {
  it('ranks by recent use and adds tools used in this channel in the last day', () => {
    const shadow = exposure.shadowRouters({ messageId: 'm1', userId: 'u', channelId: 'chan-a' });
    expect(shadow.top12.offered).toEqual(['web', 'tts']); // osint is outside the 30-day window
    expect(shadow.top8_channel24h.offered).toContain('tts');
    expect(exposure.shadowRouters({ messageId: 'm2', userId: 'u', channelId: 'chan-b' }).top8_channel24h.offered).toEqual(['web', 'tts']);
  });

  it('a hit means every called tool was in the set; no-tool turns are null', () => {
    const set = { offered: ['web', 'tts'] };
    expect(exposure.shadowHit(set, ['web'])).toBe(true);
    expect(exposure.shadowHit(set, ['web', 'osint'])).toBe(false);
    expect(exposure.shadowHit(set, [])).toBeNull();
  });

  it('records one row per turn with offered size, calls and shadow verdicts', () => {
    exposure.recordToolTurn({
      ctx: { messageId: 'm3', traceId: 't3', userId: 'u', channelId: 'chan-a' },
      offered: [tool('web'), tool('tts'), tool('osint')] as never,
      called: ['osint'],
      shadow: { top12: { offered: ['web', 'tts'] } },
    });
    const row = db.get<any>(`SELECT * FROM tool_turn_log WHERE message_id = 'm3'`);
    expect(row.offered_count).toBe(3);
    expect(row.tool_block_tokens).toBeGreaterThan(0);
    expect(JSON.parse(row.called)).toEqual(['osint']);
    expect(JSON.parse(row.shadow).top12).toEqual({ offered: ['web', 'tts'], size: 2, hit: false });
  });
});

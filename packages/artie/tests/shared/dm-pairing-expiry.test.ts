/**
 * P13 (state-machine audit 2026-10-31): expires_at is written as ISO ("…T…Z") but was compared
 * with datetime('now') ("… "), and 'T' > ' ', so a code that expired earlier the same UTC day
 * still looked valid. (Run within a second of UTC midnight, the pre-fix code happens to pass.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'dm-pairing-expiry-')), 'test.db');

let service: typeof import('../../src/shared/dm-pairing.js')['dmPairingService'];
let db: ReturnType<typeof import('../../src/shared/db/client.js').getSyncDb>;

beforeAll(async () => {
  ({ dmPairingService: service } = await import('../../src/shared/dm-pairing.js'));
  db =(await import('../../src/shared/db/client.js')).getSyncDb();
  service.initialize();
});

function insertCode(userId: string, code: string, expiresAt: Date): void {
  db.run(
    `INSERT INTO dm_pairing_codes (platform, user_id, username, code, expires_at) VALUES ('discord', ?, ?, ?, ?)`,
    [userId, userId, code, expiresAt.toISOString()]
  );
}

describe('DM pairing code expiry', () => {
  it('does not hand back a code that expired a moment ago', () => {
    insertCode('expired-user', '111111', new Date(Date.now() - 1000));
    const result = service.getOrCreatePairingCode('discord', 'expired-user', 'expired-user');
    expect(result.isNew).toBe(true);
    expect(result.code).not.toBe('111111');
  });

  it('still reuses a code that has not expired', () => {
    insertCode('fresh-user', '222222', new Date(Date.now() + 10 * 60 * 1000));
    const result = service.getOrCreatePairingCode('discord', 'fresh-user', 'fresh-user');
    expect(result.isNew).toBe(false);
    expect(result.code).toBe('222222');
  });

  it('listPending sweeps a code that expired a moment ago', () => {
    insertCode('sweep-user', '333333', new Date(Date.now() - 1000));
    expect(service.listPending('discord').map((p) => p.code)).not.toContain('333333');
    const row = db.get<{ status: string }>(`SELECT status FROM dm_pairing_codes WHERE code = '333333'`);
    expect(row?.status).toBe('expired');
  });
});

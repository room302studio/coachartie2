/**
 * A tiny durable key/value store for the odd bit of state a loop must not forget across
 * restarts ("did today's digest already go out?"). The drizzle `config` table was never
 * bootstrapped on prod, so this creates its own table on first use.
 */
import { getSyncDb } from './client.js';

let ready = false;

function ensureTable(): void {
  if (ready) return;
  getSyncDb().run(
    `CREATE TABLE IF NOT EXISTS kv_state (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );
  ready = true;
}

export function readState(key: string): string | undefined {
  ensureTable();
  return getSyncDb().get<{ value: string }>('SELECT value FROM kv_state WHERE key = ?', [key])?.value;
}

export function writeState(key: string, value: string): void {
  ensureTable();
  getSyncDb().run(
    `INSERT INTO kv_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

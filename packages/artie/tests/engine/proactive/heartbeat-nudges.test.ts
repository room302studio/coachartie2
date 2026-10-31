/**
 * Heartbeat nudges (2026-10-31), the blockers for lifting AUTONOMOUS_PAUSED: todo lists had
 * no cooldown (an hourly DM forever), goals were looked up only under owner 'ej' (so the
 * tool-created ones, owned by the Discord id, were never seen), and every goal nudge bumped
 * last_worked_at, hiding the goal for three days. DMs and delivery are faked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const dm = vi.hoisted(() => ({ sendDiscordDM: vi.fn(async () => true) }));
const delivery = vi.hoisted(() => ({
  deliveryManager: {
    initialize: vi.fn(async () => true),
    deliver: vi.fn(async () => ({ success: true, channel: 'discord_dm', attemptId: 1 })),
  },
}));

vi.mock('../../../src/engine/proactive/proactive-dm.js', () => dm);
vi.mock('../../../src/engine/proactive/delivery.js', () => delivery);
// The heartbeat shells out to a local kanban CLI; keep tests off this machine's tools.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execSync: () => '' };
});

const { getSyncDb } = await import('../../../src/shared/db/client.js');
const { OWNER_USER_ID } = await import('../../../src/shared/config/owner.js');
const { executeHeartbeat } = await import('../../../src/engine/proactive/heartbeat.js');
const { logGoalAction } = await import('../../../src/engine/tools/planning/goals.js');
const { readState } = await import('../../../src/shared/db/kv-state.js');

const LONG_AGO = '2026-01-01T00:00:00.000Z';
let listId = 0;

beforeAll(() => {
  // Prod's columns; the in-memory test DB doesn't bootstrap these two.
  const db = getSyncDb();
  db.exec(`CREATE TABLE IF NOT EXISTS objectives (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, goal_type TEXT NOT NULL,
    success_criteria TEXT, owner TEXT DEFAULT 'ej', created_by TEXT DEFAULT 'ej',
    status TEXT DEFAULT 'active', progress INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    target_date TEXT, last_worked_at TEXT, achieved_at TEXT, parent_goal_id TEXT, notes TEXT,
    blockers TEXT, budget_eth REAL, budget_spent_eth REAL DEFAULT 0, last_nudged_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS goal_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, action_type TEXT NOT NULL,
    action_description TEXT, triggered_at TEXT DEFAULT CURRENT_TIMESTAMP, result TEXT)`);

  const list = db.run(`INSERT INTO todo_lists (user_id, name, updated_at) VALUES (?, 'chores', ?)`, [
    OWNER_USER_ID,
    LONG_AGO,
  ]);
  listId = Number(list.lastInsertRowid);
  db.run(`INSERT INTO todo_items (list_id, content, status, position) VALUES (?, 'dishes', 'pending', 0)`, [
    listId,
  ]);
  db.run(
    `INSERT INTO objectives (id, title, goal_type, owner, last_worked_at) VALUES
       ('goal-discord', 'ship it', 'project', ?, ?),
       ('goal-legacy', 'old one', 'project', 'ej', ?)`,
    [OWNER_USER_ID, LONG_AGO, LONG_AGO]
  );
});

beforeEach(() => {
  dm.sendDiscordDM.mockClear();
  delivery.deliveryManager.deliver.mockClear();
});

describe('heartbeat nudges', () => {
  it('nudges a stale todo list once, then waits out the cooldown', async () => {
    const first = await executeHeartbeat();
    expect(first.todoNudges).toBe(1);
    expect(readState(`nudge:todo:${listId}`)).toBeDefined();

    const second = await executeHeartbeat();
    expect(second.todoNudges).toBe(0);
  });

  it('finds goals under the owner id and the legacy owner', async () => {
    getSyncDb().run(`UPDATE objectives SET last_nudged_at = NULL`);
    getSyncDb().run(`DELETE FROM kv_state WHERE key LIKE 'nudge:goal:%'`);
    await executeHeartbeat();
    const ids = delivery.deliveryManager.deliver.mock.calls.map((c: any[]) => c[0].relatedId).sort();
    expect(ids).toEqual(['goal-discord', 'goal-legacy']);
  });

  it("a nudge doesn't count as work on the goal", async () => {
    getSyncDb().run(`UPDATE objectives SET last_worked_at = ? WHERE id = 'goal-discord'`, [LONG_AGO]);
    await logGoalAction('goal-discord', 'reminder', 'Sent stalled goal reminder');
    const row = getSyncDb().get<{ last_worked_at: string }>(
      `SELECT last_worked_at FROM objectives WHERE id = 'goal-discord'`
    );
    expect(row?.last_worked_at).toBe(LONG_AGO);
  });
});

/**
 * P20 (state-machine audit 2026-10-31): the history inserts used the drizzle columns
 * (rule_text, change_type, ...) but prod's learned_rules_history is (action, old_value,
 * new_value, reason, created_by), so every history write threw after the rule write.
 * Tables below are prod's `.schema`, verbatim.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getSyncDb } from '../../src/shared/db/client.js';
import { reflectionConsolidator } from '../../src/engine/memory/reflection-consolidator.js';
import { checkReflectionThreshold } from '../../src/engine/routes/reflection.js';

// The private write paths, exercised directly (they need no LLM).
const consolidator = reflectionConsolidator as unknown as {
  storeOrUpdateRule(
    type: string,
    scope: string | null,
    rule: { ruleText: string; sourceTag: string; confidence: number; sourceCount: number; examples: string[] }
  ): Promise<boolean>;
  updateRule(
    id: number,
    u: { ruleText: string; confidence: number; changeType: string; changeReason: string }
  ): Promise<void>;
  retireRule(id: number, reason: string): Promise<void>;
};

beforeAll(() => {
  const db = getSyncDb();
  db.run(`CREATE TABLE IF NOT EXISTS learned_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL,
    scope_id TEXT,
    rule_text TEXT NOT NULL,
    source_tag TEXT,
    confidence REAL DEFAULT 0.5,
    source_count INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`DROP TABLE IF EXISTS learned_rules_history`);
  db.run(`CREATE TABLE learned_rules_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    FOREIGN KEY (rule_id) REFERENCES learned_rules(id)
  )`);
});

afterEach(() => {
  delete process.env.ENABLE_REFLECTION_CONSOLIDATION;
});

const RULE = {
  ruleText: 'Keep answers short',
  sourceTag: 'length',
  confidence: 0.7,
  sourceCount: 4,
  examples: [],
};

function history(): Array<{ rule_id: number; action: string; old_value: string | null; new_value: string | null; reason: string }> {
  return getSyncDb().all(`SELECT * FROM learned_rules_history ORDER BY id`);
}

describe('learned_rules_history writes (prod columns)', () => {
  it('create, update, modify and retire each leave a history row', async () => {
    await consolidator.storeOrUpdateRule('guild', 'g1', RULE);
    await consolidator.storeOrUpdateRule('guild', 'g1', { ...RULE, ruleText: 'Keep answers shorter' });
    const id = getSyncDb().get<{ id: number }>(`SELECT id FROM learned_rules`)!.id;
    await consolidator.updateRule(id, {
      ruleText: 'Keep answers under 3 lines',
      confidence: 0.8,
      changeType: 'updated',
      changeReason: 'weekly review',
    });
    await consolidator.retireRule(id, 'stopped helping');

    const rows = history();
    expect(rows.map((r) => r.action)).toEqual(['created', 'updated', 'updated', 'retired']);
    expect(rows.every((r) => r.rule_id === id)).toBe(true);
    expect(rows[0].old_value).toBeNull();
    expect(JSON.parse(rows[1].old_value!).rule_text).toBe('Keep answers short');
    expect(JSON.parse(rows[2].new_value!).rule_text).toBe('Keep answers under 3 lines');
    expect(JSON.parse(rows[3].old_value!).rule_text).toBe('Keep answers under 3 lines');
    expect(rows[3].new_value).toBeNull();
    expect(rows[3].reason).toBe('stopped helping');
  });
});

describe('emergency reflection route', () => {
  it('does nothing unless ENABLE_REFLECTION_CONSOLIDATION=true', async () => {
    const result = await checkReflectionThreshold({ guildId: 'g1', threshold: 1, hours: 1 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ triggered: false, disabled: true });
  });
});

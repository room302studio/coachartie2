/**
 * Tool-call ledger (tool-ledger.ts): one persisted row per logical tool call, outcome only.
 *
 * Covers: each outcome recorded exactly once, retries collapsed into one row, privacy (no
 * params/results stored), writes never throwing, 30-day pruning, and the self-stats surfaces
 * built on it (`tools`, `errors`, and the `health` output that was reported as truncated).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getSyncDb, initializeDb } from '../../src/shared/db/client.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { executeNativeToolCall, looksLikeToolFailure } from '../../src/engine/5-tool-loop/execute.js';
import { robustExecutor } from '../../src/engine/5-tool-loop/retry.js';
import {
  writeLedgerRow,
  pruneToolLedger,
  resetToolLedgerState,
  LEDGER_RETENTION_DAYS,
  describeError,
} from '../../src/engine/5-tool-loop/tool-ledger.js';
import {
  selfStatsCapability,
  toolsReport,
  errorsReport,
  parseWindowMinutes,
} from '../../src/engine/tools/ops/self-stats.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';
import type { OrchestrationContext } from '../../src/engine/2-turn/types.js';

const NOT_OWNER = 'ledger-test-visitor';
const DAY = 24 * 60 * 60 * 1000;

let flakyCalls = 0;
let probeRuns = 0;

function makeContext(userId: string, extra: Record<string, unknown> = {}): OrchestrationContext {
  return {
    messageId: 'ledger-msg',
    userId,
    originalMessage: 'test',
    source: 'test',
    capabilities: [],
    results: [],
    currentStep: 0,
    respondTo: async () => {},
    capabilityFailureCount: new Map(),
    discord_context: { guildId: 'guild-1', channelId: 'chan-1' },
    ...extra,
  } as unknown as OrchestrationContext;
}

interface Row {
  tool: string;
  action: string;
  outcome: string;
  error_class: string | null;
  attempts: number;
  user_id: string | null;
  guild_id: string | null;
}

function rows(tool = 'ledger-probe'): Row[] {
  return getSyncDb().all<Row>(
    `SELECT tool, action, outcome, error_class, attempts, user_id, guild_id
     FROM tool_call_ledger WHERE tool = ? ORDER BY id`,
    [tool]
  );
}

beforeAll(() => {
  initializeDb();
  capabilityBootstrap.initializeCapabilityRegistry();
  capabilityRegistry.register({
    name: 'ledger-probe',
    supportedActions: ['fine', 'boom', 'flaky', 'needs', 'mine', 'danger', 'soft_fail'],
    actions: {
      fine: { effect: 'read' },
      boom: { effect: 'read' },
      flaky: { effect: 'read' },
      needs: { effect: 'read', params: { topic: { type: 'string', description: 't', required: true } } },
      mine: { effect: 'read', who: 'owner' },
      danger: { effect: 'workspace' },
      soft_fail: { effect: 'read' },
    },
    description: 'ledger test probe',
    requiredParams: [],
    examples: [],
    handler: async (params: any) => {
      probeRuns++;
      if (params.action === 'boom') throw new Error('kaboom SECRET-PARAM-VALUE');
      if (params.action === 'flaky') {
        flakyCalls++;
        if (flakyCalls === 1) throw new Error('first try fails');
        return 'recovered';
      }
      if (params.action === 'soft_fail') return 'Error: the thing did not work';
      return 'fine result with a private payload';
    },
  });
});

beforeEach(() => {
  resetToolLedgerState();
  getSyncDb().exec(`CREATE TABLE IF NOT EXISTS tool_call_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, error_class TEXT, duration_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 1, user_id TEXT, guild_id TEXT)`);
  getSyncDb().exec(`DELETE FROM tool_call_ledger`);
  flakyCalls = 0;
  probeRuns = 0;
});

describe('ledger: one row per outcome, registry path', () => {
  it('ok', async () => {
    await capabilityRegistry.execute('ledger-probe', 'fine', {}, undefined, {
      userId: NOT_OWNER,
      guildId: 'g9',
    });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ action: 'fine', outcome: 'ok', user_id: NOT_OWNER, guild_id: 'g9' });
  });

  it('invalid_args (missing required param), with the param NAME but never values', async () => {
    await expect(
      capabilityRegistry.execute('ledger-probe', 'needs', { other: 'private-value' }, undefined, {
        userId: NOT_OWNER,
      })
    ).rejects.toThrow();
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('invalid_args');
    expect(r[0].error_class).toBe('missing_params:topic');
    expect(JSON.stringify(r)).not.toContain('private-value');
  });

  it('refused_owner', async () => {
    const out = await capabilityRegistry.execute('ledger-probe', 'mine', {}, undefined, {
      userId: NOT_OWNER,
    });
    expect(out).toBeTruthy();
    expect(probeRuns).toBe(0);
    expect(rows().map((x) => x.outcome)).toEqual(['refused_owner']);
  });

  it('queued_approval', async () => {
    const out = await capabilityRegistry.execute(
      'stripe',
      'create_payment_link',
      { name: 'ledger', amount: 1 },
      undefined,
      { userId: NOT_OWNER }
    );
    expect(out).toContain("needs EJ's approval");
    expect(rows('stripe').map((x) => x.outcome)).toEqual(['queued_approval']);
  });

  it('unknown_tool and unknown_action', async () => {
    await expect(capabilityRegistry.execute('no-such-tool-xyz', 'go', {})).rejects.toThrow();
    // (an undeclared action is owner-gated first, so a non-owner would be refused_owner)
    await expect(
      capabilityRegistry.execute('ledger-probe', 'nope', {}, undefined, { userId: OWNER_USER_ID })
    ).rejects.toThrow();
    // An invented tool name is never stored (it can carry arbitrary text): "(unknown)".
    expect(rows('no-such-tool-xyz')).toEqual([]);
    expect(rows('(unknown)').map((x) => x.outcome)).toEqual(['unknown_tool']);
    expect(rows().map((x) => x.outcome)).toEqual(['unknown_action']);
  });

  it('error (handler throws) keeps a short message', async () => {
    await expect(capabilityRegistry.execute('ledger-probe', 'boom', {})).rejects.toThrow();
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('error');
    expect(r[0].error_class!.length).toBeLessThanOrEqual(200);
  });

  it('a handler that RETURNS failure text counts as error, without storing the text', async () => {
    await capabilityRegistry.execute('ledger-probe', 'soft_fail', {});
    const r = rows();
    expect(r.map((x) => x.outcome)).toEqual(['error']);
    expect(r[0].error_class).toBe('returned_error_text');
  });

  it('never stores params or results', async () => {
    await capabilityRegistry.execute('ledger-probe', 'fine', { secret: 'hunter2' }, 'private content');
    const all = JSON.stringify(getSyncDb().all(`SELECT * FROM tool_call_ledger`));
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('private content');
    expect(all).not.toContain('private payload');
  });
});

describe('ledger: native path (taint, retries)', () => {
  it('blocked_taint is recorded once, and the handler never runs', async () => {
    const ctx = makeContext(OWNER_USER_ID, { taintedByExternalContent: true, taintSource: 'web:search' });
    const out = await executeNativeToolCall(ctx, { name: 'ledger-probe', action: 'danger', params: {} });
    expect(out).toContain('SECURITY');
    expect(probeRuns).toBe(0);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ action: 'danger', outcome: 'blocked_taint', guild_id: 'guild-1' });
    expect(r[0].error_class).toBe('tainted_by:web:search');
  });

  it('a call that fails twice then succeeds is ONE ok row, not three', async () => {
    const out = await executeNativeToolCall(makeContext(NOT_OWNER), {
      name: 'ledger-probe',
      action: 'flaky',
      params: {},
    });
    expect(out).toBe('recovered');
    expect(flakyCalls).toBe(2);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: 'ok', attempts: 2 });
  });

  it('a handler that returns failure text, through the retry path, is one error row (not ok/rescued)', async () => {
    const out = await executeNativeToolCall(makeContext(NOT_OWNER), {
      name: 'ledger-probe',
      action: 'soft_fail',
      params: {},
    });
    expect(out.startsWith('Error:')).toBe(true);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: 'error', error_class: 'returned_error_text' });
  });

  it('a call that fails every attempt is ONE error row', async () => {
    const out = await executeNativeToolCall(makeContext(NOT_OWNER), {
      name: 'ledger-probe',
      action: 'boom',
      params: {},
    });
    expect(out.startsWith('Error:')).toBe(true);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: 'error', attempts: 3 });
  });

  it('invalid args retried through the executor is one invalid_args row', async () => {
    await executeNativeToolCall(makeContext(NOT_OWNER), { name: 'ledger-probe', action: 'needs', params: {} });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].outcome).toBe('invalid_args');
  });

  it('a nested registry call (approvals replay) is its own row, not folded into the outer one', async () => {
    capabilityRegistry.register({
      name: 'ledger-outer',
      supportedActions: ['wrap'],
      actions: { wrap: { effect: 'read' } },
      description: 'calls another tool from its handler',
      requiredParams: [],
      examples: [],
      handler: async () => capabilityRegistry.execute('ledger-probe', 'fine', {}),
    });
    await robustExecutor.executeWithRetry(
      { name: 'ledger-outer', action: 'wrap', content: '', params: {} },
      { userId: NOT_OWNER, messageId: 'm' },
      1
    );
    expect(rows('ledger-outer').map((x) => x.outcome)).toEqual(['ok']);
    expect(rows('ledger-probe').map((x) => x.outcome)).toEqual(['ok']);
  });
});

describe('ledger: never throws, prunes', () => {
  it('writeLedgerRow swallows a broken table', () => {
    getSyncDb().exec(`DROP TABLE tool_call_ledger`);
    getSyncDb().exec(`CREATE TABLE tool_call_ledger (only_this TEXT)`);
    // ensureTable thinks the table exists (same db handle) and the INSERT then fails.
    expect(() => writeLedgerRow({ tool: 't', action: 'a', outcome: 'ok' })).not.toThrow();
    getSyncDb().exec(`DROP TABLE tool_call_ledger`);
    resetToolLedgerState();
  });

  it('a ledger failure does not break the tool call', async () => {
    getSyncDb().exec(`DROP TABLE tool_call_ledger`);
    getSyncDb().exec(`CREATE TABLE tool_call_ledger (only_this TEXT)`);
    const out = await capabilityRegistry.execute('ledger-probe', 'fine', {});
    expect(out).toContain('fine result');
    getSyncDb().exec(`DROP TABLE tool_call_ledger`);
    resetToolLedgerState();
  });

  it('clips error text to 200 chars; an unregistered tool/action name is never stored', () => {
    writeLedgerRow({ tool: 'x'.repeat(300), action: 'a', outcome: 'error', errorClass: 'e'.repeat(500) });
    const row = getSyncDb().get<{ tool: string; action: string; error_class: string }>(
      `SELECT tool, action, error_class FROM tool_call_ledger`
    );
    // Codex: a model-invented name can carry arbitrary text, and self-stats:tools is public.
    expect(row!.tool).toBe('(unknown)');
    expect(row!.action).toBe('(unknown)');
    expect(row!.error_class.length).toBe(200);
  });

  it('a real tool with an invented action keeps the tool, hides the action', () => {
    writeLedgerRow({ tool: 'memory', action: 'secret-text-here', outcome: 'unknown_action' });
    writeLedgerRow({ tool: 'memory', action: 'recall', outcome: 'ok' });
    const rows = getSyncDb().all<{ tool: string; action: string }>(
      `SELECT tool, action FROM tool_call_ledger ORDER BY id`
    );
    expect(rows.slice(-2)).toEqual([
      { tool: 'memory', action: '(unknown)' },
      { tool: 'memory', action: 'recall' },
    ]);
  });

  it('prunes rows older than the retention window and keeps newer ones', () => {
    const now = Date.now();
    pruneToolLedger(now); // first-use prune done; the explicit prune below is the one under test
    // Told apart by outcome: names must be registered to be stored (unregistered = "(unknown)").
    writeLedgerRow({ tool: 'memory', action: 'recall', outcome: 'error' }, now - (LEDGER_RETENTION_DAYS + 1) * DAY);
    writeLedgerRow({ tool: 'memory', action: 'recall', outcome: 'invalid_args' }, now - (LEDGER_RETENTION_DAYS - 1) * DAY);
    writeLedgerRow({ tool: 'memory', action: 'recall', outcome: 'ok' }, now);
    const removed = pruneToolLedger(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = getSyncDb()
      .all<{ outcome: string }>(`SELECT outcome FROM tool_call_ledger ORDER BY outcome`)
      .map((r) => r.outcome);
    expect(left).toEqual(['invalid_args', 'ok']);
  });

  it('describeError keeps structured registry errors to their code', () => {
    const e = new Error(JSON.stringify({ errorCode: 'PARAM_MISSING_001', message: 'x', providedParams: { a: 'secret' } }));
    expect(describeError(e)).toBe('PARAM_MISSING_001');
  });

  it('looksLikeToolFailure is still exported from execute.ts', () => {
    expect(looksLikeToolFailure('Error: nope')).toBe(true);
    expect(looksLikeToolFailure('all good')).toBe(false);
  });
});

describe('self-stats: tools', () => {
  it('is declared read-only, open to everyone (aggregate, no per-user data)', () => {
    expect(selfStatsCapability.actions?.tools).toMatchObject({ effect: 'read' });
    expect(selfStatsCapability.actions?.tools.who).toBeUndefined();
    expect(selfStatsCapability.supportedActions).toContain('tools');
  });

  it('keeps user_id and limit visible to the model now that params are declared', () => {
    expect(selfStatsCapability.actions?.user_costs.params).toHaveProperty('user_id');
    expect(selfStatsCapability.actions?.top_spenders.params).toHaveProperty('limit');
  });

  it('reports calls, ok %, failure outcomes, causes and never-called tools', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) writeLedgerRow({ tool: 'ledger-probe', action: 'fine', outcome: 'ok' }, now);
    writeLedgerRow({ tool: 'ledger-probe', action: 'needs', outcome: 'invalid_args', errorClass: 'missing_params:topic' }, now);
    writeLedgerRow({ tool: 'ledger-probe', action: 'needs', outcome: 'invalid_args', errorClass: 'missing_params:topic' }, now);
    writeLedgerRow({ tool: 'ledger-probe', action: 'boom', outcome: 'error', errorClass: 'Error: kaboom' }, now);
    writeLedgerRow({ tool: 'ledger-probe', action: 'fine', outcome: 'ok' }, now - 20 * DAY); // outside 7d

    const text = await selfStatsCapability.handler({ action: 'tools' }, undefined, undefined);
    expect(text).toContain('Tool calls, last 7d');
    expect(text).toContain('6 calls, 50% ok');
    expect(text).toContain('ledger-probe:fine | 3 | 100% | -');
    expect(text).toContain('ledger-probe:needs | 2 | 0% | invalid_args 2');
    expect(text).toContain('ledger-probe:needs invalid_args - missing_params:topic (2)');
    expect(text).toContain('Never called in the last 7d');
    expect(text).toContain('self-stats'); // registered (in the boot list) but never called here
    expect(text).not.toMatch(/Never called[^\n]*ledger-probe/);
  });

  it('honours timeRange and has an empty-window message', () => {
    expect(toolsReport(60)).toContain('No tool calls recorded in this window.');
    writeLedgerRow({ tool: 'ledger-probe', action: 'fine', outcome: 'ok' }, Date.now() - 3 * DAY);
    expect(toolsReport(24 * 60)).toContain('No tool calls recorded');
    expect(toolsReport(7 * 24 * 60)).toContain('1 calls, 100% ok');
  });

  it('parses windows', () => {
    expect(parseWindowMinutes('30m', 1)).toBe(30);
    expect(parseWindowMinutes('6h', 1)).toBe(360);
    expect(parseWindowMinutes('7d', 1)).toBe(7 * 1440);
    expect(parseWindowMinutes('2', 1)).toBe(120);
    expect(parseWindowMinutes('soon', 99)).toBe(99);
    expect(parseWindowMinutes('900d', 1)).toBe(30 * 1440);
  });
});

describe('self-stats: errors counts from the DB and says what it counts', () => {
  function addLlmRow(success: number, errorType: string | null): void {
    getSyncDb().run(
      `INSERT INTO model_usage_stats (model_name, user_id, message_id, success, error_type) VALUES (?, ?, ?, ?, ?)`,
      ['test/model', 'u', 'm', success, errorType]
    );
  }

  it('counts failed LLM calls (the figure behind "10% API errors") and tool failures', async () => {
    getSyncDb().exec(`DELETE FROM model_usage_stats`);
    for (let i = 0; i < 9; i++) addLlmRow(1, null);
    addLlmRow(0, 'http_402');
    writeLedgerRow({ tool: 'ledger-probe', action: 'boom', outcome: 'error' });
    writeLedgerRow({ tool: 'ledger-probe', action: 'mine', outcome: 'refused_owner' });
    writeLedgerRow({ tool: 'ledger-probe', action: 'fine', outcome: 'ok' });

    const text = await selfStatsCapability.handler({ action: 'errors' }, undefined, undefined);
    expect(text).toContain('**LLM calls:** 1 failed of 10 (10%)');
    expect(text).toContain('http_402: 1');
    expect(text).toContain('**Tool calls:** 1 failed of 3 (33%), plus 1 policy stops');
    expect(text).toContain('ledger-probe:boom error: 1');
    expect(text).toContain('model_usage_stats');
    expect(text).toContain('Neither resets on restart');
    expect(text).not.toContain('No errors recorded since last restart');
    getSyncDb().exec(`DELETE FROM model_usage_stats`);
  });

  it('matches the distress monitor definition (same rows, same flag)', () => {
    getSyncDb().exec(`DELETE FROM model_usage_stats`);
    addLlmRow(1, null);
    addLlmRow(0, 'http_500');
    expect(errorsReport(60)).toContain('1 failed of 2 (50%)');
    getSyncDb().exec(`DELETE FROM model_usage_stats`);
  });
});

describe('self-stats: health (reported as cut off after the heap line)', () => {
  it('returns every section: memory, uptime, event loop, handles, requests', async () => {
    const text = await selfStatsCapability.handler({ action: 'health' }, undefined, undefined);
    expect(text).toContain('**Memory:**');
    expect(text).toContain('- Heap Used:');
    expect(text).toContain('- Heap Total:');
    // Sections after the memory block must still be present: the tool builds the whole
    // string; a reply cut off after the heap figures happens downstream of this function.
    expect(text).toContain('**Event Loop Lag:**');
    expect(text).toContain('**Active Handles:**');
    expect(text).toContain('**Active Requests:**');
  });

  it('overview ends with its last line (messages processed)', async () => {
    const text = await selfStatsCapability.handler({ action: 'overview' }, undefined, undefined);
    expect(text).toContain('**Memory:**');
    expect(text).toContain('**Messages Processed:**');
  });
});

// Codex 2026-11-17: self-stats:tools is open to everyone, so a stored error must be a fixed
// category, never the exception text (which can carry tokens or a user's private input).
describe('describeError never keeps raw text', () => {
  it('maps messages to fixed categories', () => {
    const secret = 'tok_SECRET123';
    const cases: Array<[unknown, string]> = [
      [new Error(`GET https://api.x/v1?key=${secret} failed with 401`), 'http_401'],
      [new Error(`user said "${secret}" and it was not found`), 'not_found'],
      [new Error('connect ECONNREFUSED 127.0.0.1:6379'), 'network'],
      [new TypeError(`Cannot read properties of undefined (reading '${secret}')`), 'TypeError'],
      [`something odd happened with ${secret}`, 'error'],
    ];
    for (const [err, label] of cases) {
      const out = describeError(err);
      expect(out).toBe(label);
      expect(out).not.toContain(secret);
    }
  });

  it('keeps a structured error code only when it is a known registry code', () => {
    expect(describeError(new Error(JSON.stringify({ errorCode: 'PARAM_MISSING_001' })))).toBe(
      'PARAM_MISSING_001'
    );
    // Codex: a well-formed-looking code is still not trusted unless it is on the list.
    expect(describeError(new Error(JSON.stringify({ errorCode: 'live_key_SECRET123' })))).toBe(
      'structured_error'
    );
    class SecretTokenError extends Error {
      constructor() {
        super('x');
        this.name = 'tok_SECRET123Error';
      }
    }
    expect(describeError(new SecretTokenError())).toBe('error');
  });
});

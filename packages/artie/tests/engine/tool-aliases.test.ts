/**
 * Wave 4 tool-merge pin.
 *
 * Ten pre-merge tools collapse into four canonical ones (goals, tasks, sandbox, bot-config).
 * The model may still emit the old names, so every old `name:action` pair must keep resolving
 * through `resolveToolCall` to a registered canonical tool and an action that tool supports.
 *
 * PRE_MERGE_TOOLS is copied by hand from the pre-merge sources (supportedActions of
 * planning/{goal,goals,todo,quests,task-status}.ts, dev/sandbox/{shell,edit,git,search}.ts,
 * ops/{runtime-config,model-manager}.ts at e239c16). Do not regenerate it from the live registry:
 * its whole point is to remember what used to exist.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Never run real docker: every sandbox action shells out through child_process.exec.
const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn(
    (
      _cmd: string,
      optsOrCb: unknown,
      maybeCb?: (err: Error | null, out?: { stdout: string; stderr: string }) => void
    ) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
        err: Error | null,
        out?: { stdout: string; stderr: string }
      ) => void;
      // promisify(exec) without the custom symbol resolves to the single value after err,
      // so hand back one {stdout, stderr} object, exactly what the handlers destructure.
      cb(null, { stdout: 'mocked-output\n', stderr: '' });
      return {} as unknown;
    }
  ),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, exec: execMock, default: { ...actual, exec: execMock } };
});

import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import {
  capabilityRegistry,
  resolveToolCall,
  TOOL_ALIASES,
} from '../../src/engine/5-tool-loop/registry.js';
import { getRawDb } from '../../src/shared/db/client.js';

const PRE_MERGE_TOOLS: Record<string, string[]> = {
  // planning/goal.ts
  goal: ['set', 'check', 'update', 'complete', 'history'],
  // planning/goals.ts (the surviving canonical tool; pinned so its own actions never regress)
  goals: [
    'create',
    'list',
    'status',
    'progress',
    'update',
    'achieve',
    'complete',
    'abandon',
    'subgoal',
    'history',
    'delete',
  ],
  // planning/todo.ts
  todo: ['create', 'add', 'next', 'complete', 'status', 'list'],
  // planning/quests.ts
  quests: [
    'start',
    'create',
    'next',
    'current',
    'status',
    'complete',
    'done',
    'finish',
    'skip',
    'list',
    'abandon',
    'cancel',
    'resume',
    'clear',
  ],
  // planning/task-status.ts
  'task-status': [
    'start',
    'begin',
    'update',
    'progress',
    'complete',
    'done',
    'finish',
    'fail',
    'error',
    'list',
    'active',
    'cancel',
    'abort',
  ],
  // dev/sandbox/shell.ts
  shell: ['exec', 'send', 'read', 'split', 'list'],
  // dev/sandbox/edit.ts
  edit: ['replace', 'read', 'insert', 'delete'],
  // dev/sandbox/git.ts
  git: ['status', 'diff', 'log', 'branch', 'show', 'blame'],
  // dev/sandbox/search.ts (the dev one, not web search)
  search: ['files', 'content', 'both'],
  // ops/runtime-config.ts
  runtime_config: [
    'get_active_model',
    'set_model_tier',
    'get_context_size',
    'set_context_size',
    'get_iteration_limits',
    'set_iteration_limits',
    'auto_optimize',
  ],
  // ops/model-manager.ts
  model_manager: ['list_models', 'get_pricing', 'get_recommendation', 'compare_models'],
};

const CANONICAL = ['goals', 'tasks', 'sandbox', 'bot-config'];

const PAIRS = Object.entries(PRE_MERGE_TOOLS).flatMap(([name, actions]) =>
  actions.map((action) => [name, action] as const)
);

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
});

describe('tool alias map', () => {
  it.each(PAIRS)('%s:%s resolves to a registered canonical tool + action', (name, action) => {
    const resolved = resolveToolCall(name, action, {});
    expect(TOOL_ALIASES[resolved.name]).toBeUndefined();
    const cap = capabilityRegistry.list().find((c) => c.name === resolved.name);
    expect(cap, `${name}:${action} -> ${resolved.name} is not registered`).toBeDefined();
    expect(cap!.supportedActions).toContain(resolved.action);
  });

  it('registers every canonical tool and none of the old names', () => {
    const names = capabilityRegistry.list().map((c) => c.name);
    for (const canonical of CANONICAL) {
      expect(names).toContain(canonical);
    }
    for (const alias of Object.keys(TOOL_ALIASES)) {
      expect(names).not.toContain(alias);
    }
  });

  it('every alias targets a registered canonical tool', () => {
    for (const [alias, entry] of Object.entries(TOOL_ALIASES)) {
      expect(capabilityRegistry.has(entry.to), `${alias} -> ${entry.to}`).toBe(true);
      expect(TOOL_ALIASES[entry.to]).toBeUndefined();
    }
  });

  it('keeps an unknown action on an old name, but still maps the name', () => {
    expect(resolveToolCall('git', 'push', {})).toMatchObject({ name: 'sandbox', action: 'push' });
  });

  it('leaves canonical and unrelated tools untouched', () => {
    expect(resolveToolCall('sandbox', 'exec', { command: 'ls' })).toMatchObject({
      name: 'sandbox',
      action: 'exec',
      params: { command: 'ls' },
    });
    expect(resolveToolCall('web', 'search', {})).toMatchObject({ name: 'web', action: 'search' });
  });

  it('the prompt roster lists only canonical names', () => {
    const roster = capabilityRegistry.generateCompressedInstructions();
    const listed = roster
      .slice(roster.indexOf('Available: ') + 'Available: '.length)
      .split(/\), /)
      .map((entry) => entry.slice(0, entry.indexOf('(')));
    for (const alias of Object.keys(TOOL_ALIASES)) {
      expect(listed).not.toContain(alias);
    }
    for (const canonical of CANONICAL) {
      expect(listed).toContain(canonical);
    }
  });

  it('has/supportsAction/get see through aliases', () => {
    expect(capabilityRegistry.has('shell')).toBe(true);
    expect(capabilityRegistry.supportsAction('git', 'status')).toBe(true);
    expect(capabilityRegistry.get('todo', 'next').name).toBe('tasks');
  });
});

describe('execution through an alias', () => {
  beforeEach(() => {
    execMock.mockClear();
  });

  it('shell:exec runs sandbox:exec with the same docker command', async () => {
    const out = await capabilityRegistry.execute('shell', 'exec', { command: 'echo hi' });
    expect(out).toContain('$ echo hi');
    expect(out).toContain('mocked-output');
    // Boolean assert on purpose: shell's tmux/pwd helper puts `-e GITHUB_TOKEN=<value>` in its
    // command string (logged as a wave-7 item), so a failing toContain must never print the
    // captured commands.
    const commands = execMock.mock.calls.map((c) => c[0]);
    expect(
      commands.includes(
        'docker exec -w /workspace -e GITHUB_TOKEN -e OPENAI_API_KEY coachartie-sandbox /bin/bash -c "echo hi"'
      ),
      'sandbox:exec docker command unchanged'
    ).toBe(true);
  });

  it('git:status runs sandbox:git_status in the same container', async () => {
    const out = await capabilityRegistry.execute('git', 'status', {});
    expect(out).toContain('Branch: mocked-output');
    const commands = execMock.mock.calls.map((c) => c[0]);
    expect(
      commands.includes('docker exec -w /workspace coachartie-sandbox /bin/bash -c "git status"'),
      'sandbox:git_status docker command unchanged'
    ).toBe(true);
  });

  it('task-status:start runs tasks with tracker=task', async () => {
    const out = await capabilityRegistry.execute(
      'task-status',
      'start',
      { taskName: 'pin the aliases' },
      undefined,
      { userId: 'alias-test-user' }
    );
    expect(out).toContain('Started:** pin the aliases');
    const list = await capabilityRegistry.execute(
      'tasks',
      'active',
      {},
      undefined,
      { userId: 'alias-test-user' }
    );
    expect(list).toContain('pin the aliases');
  });

  it('runtime_config:get_iteration_limits runs bot-config', async () => {
    const out = await capabilityRegistry.execute('runtime_config', 'get_iteration_limits', {});
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty('max_iterations');
  });

  it('goal:set creates a goal in goals, and goal:check lists it', async () => {
    // test-setup's initializeDb does not create the objectives tables; mirror schema.ts.
    const raw = getRawDb();
    raw.exec(`CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, goal_type TEXT NOT NULL,
      success_criteria TEXT, owner TEXT DEFAULT 'ej', created_by TEXT DEFAULT 'ej',
      status TEXT DEFAULT 'active', progress INTEGER DEFAULT 0, target_date TEXT,
      last_worked_at TEXT, achieved_at TEXT, parent_goal_id TEXT, notes TEXT, blockers TEXT,
      budget_eth REAL, budget_spent_eth REAL DEFAULT 0, last_nudged_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    raw.exec(`CREATE TABLE IF NOT EXISTS goal_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, action_type TEXT NOT NULL,
      action_description TEXT, result TEXT, triggered_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

    const ctx = { userId: 'alias-goal-user' };
    const created = await capabilityRegistry.execute(
      'goal',
      'set',
      { objective: 'ship wave four' },
      undefined,
      ctx
    );
    expect(created).toContain('Goal Created');
    expect(created).toContain('ship wave four');

    const listed = await capabilityRegistry.execute('goal', 'check', {}, undefined, ctx);
    expect(listed).toContain('ship wave four');
  });
});

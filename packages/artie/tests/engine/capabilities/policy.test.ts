/**
 * Tool policy (tool-policy.ts): gates are derived from each tool's declared per-action effect.
 *
 * GATE_FLOOR is the security floor, written out as static data on purpose (not computed from
 * anything in src): it is what every gated tool must do. Add rows freely; removing or loosening
 * one should be a deliberate edit here with a reason, never a side effect of a declaration.
 *
 * Flags: O = owner only, T = blocked when the turn is tainted by outside text, A = needs EJ's
 * approval. '' = open.
 *
 * Changes vs the old hand-kept tables (2026-11-17), all intentional:
 *  tightened  T added: http post/put/delete, reddit post/comment, github writes, mediawiki
 *             write/add, stripe (all also approval-gated); deep_research submit (spends money).
 *  loosened   T removed from pure reads: sandbox list_panes/read_pane/git_show/git_blame,
 *             mention_proxy list/get/list_for_*, filesystem read_file/list_directory (the old
 *             exemptions named 'read'/'list', which aren't actions), email status, scheduler list.
 *  new        hermes: owner only + T (it was ungated until 2026-11-17).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { capabilityBootstrap } from '../../../src/engine/capabilities/register-all.js';
import { capabilityRegistry } from '../../../src/engine/capabilities/registry.js';
import {
  gatesFor,
  undeclaredActions,
  strayDeclarations,
  canonicalParams,
  requiredParamsFor,
} from '../../../src/engine/capabilities/policy.js';

const GATE_FLOOR: Record<string, Record<string, string>> = {
  sandbox: {
    exec: 'OT', send: 'OT', split: 'OT', insert: 'OT', replace: 'OT', delete: 'OT',
    read_file: 'O', find_files: 'O', grep: 'O', search: 'O', list_panes: 'O', read_pane: 'O',
    git_status: 'O', git_log: 'O', git_diff: 'O', git_branch: 'O', git_show: 'O', git_blame: 'O',
  },
  hermes: { execute: 'OT', ask: 'OT', status: 'O' },
  http: { get: 'O', post: 'OTA', put: 'OTA', delete: 'OTA' },
  osint: {
    'recent-signals': 'O', 'lookup-signal': 'O', 'search-signals': 'O', investigations: 'O',
    'lookup-flight': 'O', 'recent-flights': 'O', 'military-activity': 'O',
    'flight-anomalies': 'O', 'nearby-aircraft': 'O', 'lookup-entity': 'O', explain: 'O',
  },
  system_memory: { read: 'O', recent: 'O', check_handoffs: 'O', write: 'O', handoff: 'O' },
  // relay list/clear take any recipient's queue (`to`), so they are owner-only; add reaches a person.
  relay: { add: 'T', list: 'O', clear: 'OT' },
  // write/clear replace or wipe the whole notebook (taint-blocked); note/append/section add a line.
  scratchpad: { read: '', note: '', append: '', section: '', write: 'T', clear: 'T' },
  mention_proxy: {
    list: 'O', get: 'O', list_for_guild: 'O', list_for_user: 'O',
    create: 'OT', update: 'OT', delete: 'OT', enable: 'OT', disable: 'OT',
  },
  'self-stats': {
    overview: '', costs: '', capabilities: '', health: '', errors: '', tools: '', top_spenders: '',
    banlist: '', rules: '', user_costs: 'O',
  },
  deep_research: { submit: 'OT', status: '', results: '', harness_status: '' },
  filesystem: { read_file: '', list_directory: '', exists: '' },
  email: { send: 'TA', status: '' },
  scheduler: { remind: 'T', remind_every: 'T', schedule: 'T', cancel: 'T', list: '' },
  'discord-moderation': { timeout: 'T', add_enemy_role: 'T', remove_enemy_role: 'T', escalate: '' },
  'discord-nickname': { set_nickname: 'T', reset_nickname: 'T' },
  'discord-reaction': { react: 'T', read: '', rollup: '' },
  'discord-search': { search: '' },
  'discord-channels': { get_messages: '', get_pinned_messages: '' },
  'discord-threads': { create_thread: 'T', get_thread_messages: '' },
  'discord-user-history': { get_user_messages: '' },
  'discord-send-message': {
    send_message: 'T', edit_message: 'T', delete_message: 'T', pin_message: 'T', unpin_message: 'T',
  },
  'discord-poll': { create_poll: 'T', read_poll: '', end_poll: 'T' },
  // Recording people is EJ's call (same as /scribe start/stop); anyone may ask the status.
  scribe: { status: '', last_summary: '', start: 'OT', stop: 'OT' },
  'proactive-dm': {
    send: 'T', dm: 'T', message: 'T', notify: 'T', alert: 'T', remind: 'T', followup: 'T',
    status: '',
  },
  'discord-ui': { modal: 'T', buttons: 'T', select: 'T', 'context-menu': 'T' },
  stripe: { create_payment_link: 'TA', deactivate_payment_link: 'TA' },
  reddit: {
    status: '', 'list-subreddits': '', read: '', search: '', mentions: '', post: 'TA', comment: 'TA',
  },
  github: {
    get_releases: '', get_recent_commits: '', get_deployment_stats: '', search_repositories: '',
    list_issues: '', search_issues: '', get_issues_by_label: '', get_issue_details: '',
    get_related_prs: '', find_similar_issues: '', list_triage: '',
    create_issue: 'TA', update_issue: 'TA', add_comment: 'TA', add_labels: 'TA', remove_label: 'TA',
  },
  mediawiki: { read: '', search: '', list: '', write: 'TA', add: 'TA' },
  // sync-to-github creates GitHub issues: approval-gated from 2026-11-17 (it skipped the gate).
  'discord-forums': {
    'list-forums': '', 'list-threads': '', 'get-thread': '', 'get-forum-summary': '',
    'sync-to-github': 'TA', 'create-post': 'T',
  },
  // approve replays an email/payment: taint-blocked so injected text can't approve for EJ.
  approvals: { list: 'O', approve: 'OT', deny: 'OT' },
  'meeting-scheduler': {
    create: 'T', update: 'T', cancel: 'T', 'suggest-time': '', 'check-availability': '', list: '',
  },
};

/**
 * Tools not declared yet (EJ 2026-11-17: undeclared = open, but loud). SHRINK ONLY: a new tool
 * must ship declared, and a tool that becomes fully declared must be removed from here.
 */
const KNOWN_UNDECLARED = new Set([
  'ask-question', 'autonomous', 'bot-config', 'calculator', 'community-analytics',
  'context', 'credit_status', 'diagnose',
  'discord-issue-parser',
  'embedded_mcp', 'flashcard', 'goals', 'image_gen',
  'kanban', 'morning-briefing', 'n8n_browser', 'pairing',
  'quiz-game', 'sb_changelog', 'scrapbook', 'send-metro-file', 'sequence',
  'skills', 'system-info', 'system_monitor', 'tasks', 'trend-watcher', 'tts', 'user-profile',
  'vision', 'vps_claude', 'web', 'wolfram',
]);

function flags(tool: string, action: string): string {
  const cap = capabilityRegistry.list().find((c) => c.name === tool);
  const g = gatesFor(cap?.actions, action);
  let out = '';
  if (g.ownerOnly) out += 'O';
  if (g.dangerousWhenTainted) out += 'T';
  if (g.needsApproval) out += 'A';
  return out;
}

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
});

describe('gate floor: every gated tool behaves exactly as written here', () => {
  for (const [tool, actions] of Object.entries(GATE_FLOOR)) {
    it(`${tool}`, () => {
      const cap = capabilityRegistry.list().find((c) => c.name === tool);
      expect(cap, `${tool} is not registered`).toBeDefined();
      // The floor covers every action the tool supports, so a new action can't slip in open.
      expect(Object.keys(actions).sort()).toEqual([...cap!.supportedActions].sort());
      for (const [action, expected] of Object.entries(actions)) {
        expect(flags(tool, action), `${tool}:${action}`).toBe(expected);
      }
    });
  }
});

describe('declaration coverage (undeclared = open, so it must be loud)', () => {
  it('no new tool ships undeclared; KNOWN_UNDECLARED only shrinks', () => {
    const caps = capabilityRegistry.list();
    const undeclaredTools = new Set(undeclaredActions(caps).map((a) => a.split(':')[0]));
    const surprise = [...undeclaredTools].filter((t) => !KNOWN_UNDECLARED.has(t));
    expect(surprise, 'declare actions on these tools (tool-policy.ts)').toEqual([]);
    const done = [...KNOWN_UNDECLARED].filter(
      (t) => caps.some((c) => c.name === t) && !undeclaredTools.has(t)
    );
    expect(done, 'fully declared now: remove from KNOWN_UNDECLARED').toEqual([]);
  });

  it('every declared action is a supported action (no typos)', () => {
    expect(strayDeclarations(capabilityRegistry.list())).toEqual([]);
  });
});

describe('gatesFor', () => {
  const actions = {
    look: { effect: 'read' as const },
    send: { effect: 'outside' as const, who: 'owner' as const },
  };

  it('an undeclared tool is open on every gate', () => {
    expect(gatesFor(undefined, 'anything')).toEqual({
      declared: false, ownerOnly: false, dangerousWhenTainted: false, needsApproval: false,
    });
  });

  it('an action a declared tool does not list gets that tool\'s strictest gates', () => {
    expect(gatesFor(actions, 'synonym')).toEqual({
      declared: true, ownerOnly: true, dangerousWhenTainted: true, needsApproval: true,
    });
  });

  it('inherited object keys are not declarations (sandbox:constructor stays owner-only)', () => {
    expect(gatesFor(actions, 'constructor').ownerOnly).toBe(true);
    expect(gatesFor(actions, 'toString').needsApproval).toBe(true);
  });

  it('per-action required params bind in registry.execute, with the field named', async () => {
    await expect(
      capabilityRegistry.execute('discord-forums', 'list-threads', {}, undefined, { userId: 'u' })
    ).rejects.toThrow(/forumId/);
  });

  it('declared aliases are renamed before validation (forum_id satisfies forumId)', () => {
    const forums = capabilityRegistry.list().find((c) => c.name === 'discord-forums')!;
    expect(canonicalParams(forums.actions, 'list-threads', { forum_id: '1' })).toEqual({ forumId: '1' });
    expect(canonicalParams(forums.actions, 'list-threads', { forum_id: '1', forumId: '2' })).toEqual({
      forumId: '2',
    });
    expect(requiredParamsFor(forums.actions, 'list-threads')).toEqual(['forumId']);
  });

  it('approval can be switched off explicitly (owner-run money, e.g. deep_research)', () => {
    expect(gatesFor({ x: { effect: 'money', approval: false } }, 'x').needsApproval).toBe(false);
  });
});

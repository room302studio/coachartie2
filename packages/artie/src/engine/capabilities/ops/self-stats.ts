import { logger } from '../../../shared/logger.js';
import { getSyncDb } from '../../../shared/db/client.js';
import {
  isBlockedUser,
  BLOCKED_USER_EPITHET,
  BLOCKED_USER_IDS,
  BLOCKED_USERS,
} from '../../../shared/blocklist.js';
import { isOptedOut } from '../../../shared/privacy-opt-out.js';
import { RegisteredCapability, capabilityRegistry, CapabilityContext } from '../registry.js';
import { isOwner } from '../../../shared/config/owner.js';
import {
  ledgerCounts,
  ledgerFirstTs,
  ledgerCapabilitiesCalled,
  ledgerTopFailures,
} from '../ledger.js';
import { metricsRegistry } from '../../health/metrics.js';
import { registryToTools } from '../../5-tool-loop/tool-schema.js';
import { loadRulesReport } from './rules-format.js';

/**
 * Self-Stats capability - Artie can check his own health and metrics
 *
 * Lets Artie introspect on:
 * - API costs and token usage
 * - Capability usage stats
 * - Memory/CPU usage
 * - Recent errors
 * - Service health
 */

interface SelfStatsParams {
  action:
    | 'overview'
    | 'costs'
    | 'capabilities'
    | 'health'
    | 'errors'
    | 'tools'
    | 'user_costs'
    | 'top_spenders'
    | 'banlist'
    | 'rules';
  timeRange?: string; // e.g., '1h', '24h', '7d'
  user_id?: string; // for user_costs — defaults to whoever is asking
  limit?: number; // for top_spenders
}

// ── Per-user cost accounting (model_usage_stats) ──────────────────────────
// Answers "how much money have I cost EJ?" with receipts instead of an empty
// generation. Blocked users are redacted, not shown — they don't exist.

function redactUser(userId: string): string {
  if (BLOCKED_USER_IDS.has(userId)) return BLOCKED_USER_EPITHET;
  if (isBlockedUser(userId)) {
    return 'someone who opted out';
  }
  return `<@${userId}>`;
}

/**
 * The current banlist, on demand (EJ 2026-11-18: "have him report the current banlist").
 * The one place banned users are named: a moderation record, public on purpose. Opt-outs are
 * a private choice and never listed.
 */
function banlistReport(): string {
  // Anyone who also opted out is never named (Codex 2026-11-18); ids are never shown either.
  const listed = BLOCKED_USERS.filter((u) => !isOptedOut(u.id) && u.names.length > 0);
  if (BLOCKED_USERS.length === 0) return 'Banlist: empty. Nobody is banned right now.';
  if (listed.length === 0) return 'Banlist: no public entries.';
  const rows = listed.map((u) => {
    let since = '';
    if (u.since) since = ` (since ${u.since})`;
    return `- ${u.names[0]}${since}`;
  });
  return `Banlist (${listed.length}, set by EJ; I ignore these people until EJ lifts it):\n${rows.join('\n')}`;
}

function userCostsReport(db: ReturnType<typeof getSyncDb>, userId: string): string {
  if (isBlockedUser(userId)) {
    return 'No usage data available for that user.';
  }
  const total = db.get<{ calls: number; tokens: number; cost: number }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(estimated_cost),0) AS cost
     FROM model_usage_stats WHERE user_id = ?`,
    [userId]
  );
  if (!total || total.calls === 0) {
    return `No LLM usage recorded for user ${userId}. They're free (so far).`;
  }
  const topDays = db.all<{ day: string; calls: number; cost: number }>(
    `SELECT date(timestamp) AS day, COUNT(*) AS calls, SUM(estimated_cost) AS cost
     FROM model_usage_stats WHERE user_id = ?
     GROUP BY day ORDER BY cost DESC LIMIT 3`,
    [userId]
  );
  const today = db.get<{ calls: number; cost: number }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(estimated_cost),0) AS cost
     FROM model_usage_stats WHERE user_id = ? AND date(timestamp) = date('now')`,
    [userId]
  );
  // Rank among all users by lifetime cost (blocked users still occupy ranks;
  // we just never name them).
  const rank = db.get<{ rank: number }>(
    `SELECT COUNT(*) + 1 AS rank FROM (
       SELECT user_id, SUM(estimated_cost) AS c FROM model_usage_stats
       GROUP BY user_id HAVING c > (
         SELECT SUM(estimated_cost) FROM model_usage_stats WHERE user_id = ?
       )
     )`,
    [userId]
  );

  const lines = [
    `## Cost report for <@${userId}>`,
    `**Lifetime:** $${total.cost.toFixed(2)} — ${total.calls} LLM calls, ${total.tokens.toLocaleString()} tokens`,
    `**Server rank:** #${rank?.rank ?? '?'} by lifetime cost`,
    `**Today:** $${(today?.cost ?? 0).toFixed(2)} (${today?.calls ?? 0} calls)`,
    '',
    '**Most expensive days:**',
    ...topDays.map((d) => `- ${d.day}: $${d.cost.toFixed(2)} (${d.calls} calls)`),
  ];
  return lines.join('\n');
}

/**
 * Biggest spenders. In a server: that server's usage only (Codex crew 2026-11-18: it showed
 * every server's people and totals). Outside a server only EJ gets the all-servers view.
 */
function topSpendersReport(
  db: ReturnType<typeof getSyncDb>,
  limit: number,
  guildId: string | null,
  viewerId: string
): string {
  let scope = 'this server';
  let where = 'WHERE guild_id = ?';
  let args: unknown[] = [guildId];
  if (guildId === null) {
    if (!isOwner(viewerId)) return 'The spending leaderboard is per server. Ask in a server.';
    scope = 'all servers';
    where = '';
    args = [];
  }
  // SQLite reads LIMIT -1 as "no limit", so clamp to 1-25 here (Codex crew).
  const capped = Math.max(1, Math.min(Math.trunc(limit) || 10, 25));
  const rows = db.all<{ user_id: string; calls: number; cost: number }>(
    `SELECT user_id, COUNT(*) AS calls, SUM(estimated_cost) AS cost
     FROM model_usage_stats ${where}
     GROUP BY user_id ORDER BY cost DESC LIMIT ?`,
    [...args, capped]
  );
  if (rows.length === 0) return 'No usage recorded yet.';
  const serverTotal = db.get<{ cost: number }>(
    `SELECT COALESCE(SUM(estimated_cost),0) AS cost FROM model_usage_stats ${where}`,
    args
  );
  const lines = [
    `## Top ${rows.length} credit consumers (lifetime, ${scope})`,
    `Total: $${(serverTotal?.cost ?? 0).toFixed(2)}`,
    '',
    ...rows.map(
      (r, i) =>
        `${i + 1}. ${redactUser(r.user_id)} — $${r.cost.toFixed(2)} (${r.calls} calls)`
    ),
    '',
    '_Note: <@id> mentions ping people — consider paraphrasing names instead of pasting raw._',
  ];
  return lines.join('\n');
}

// ── Windows ────────────────────────────────────────────────────────────────

const MAX_WINDOW_MINUTES = 30 * 24 * 60; // the tool ledger keeps 30 days

/** '30m' | '6h' | '7d' (bare number = hours) -> minutes. Falls back to `fallbackMinutes`. */
export function parseWindowMinutes(raw: unknown, fallbackMinutes: number): number {
  const match = String(raw ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)?$/);
  if (!match) return fallbackMinutes;
  const n = parseFloat(match[1]);
  const unit = match[2] ?? 'h';
  let minutes = n * 60;
  if (unit === 'm') minutes = n;
  if (unit === 'd') minutes = n * 24 * 60;
  if (!(minutes > 0)) return fallbackMinutes;
  return Math.min(Math.round(minutes), MAX_WINDOW_MINUTES);
}

function describeWindow(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

// ── tools: the persisted tool-call ledger ──────────────────────────────────

/**
 * Per tool:action: calls, ok %, top failure outcomes; then the top failure causes and the
 * tools that were never called in the window. Reads tool_call_ledger (persisted, 30 days), so
 * it survives restarts. Outcomes only: no params, content or results are ever stored.
 */
export function toolsReport(windowMinutes: number, now: number = Date.now()): string {
  const since = now - windowMinutes * 60 * 1000;
  const label = describeWindow(windowMinutes);
  const cells = ledgerCounts(since);
  const firstTs = ledgerFirstTs();

  const lines: string[] = [`## Tool calls, last ${label}`];
  if (firstTs !== null && firstTs > since) {
    lines.push(`(ledger only began ${new Date(firstTs).toISOString().slice(0, 16)}Z, so the window is shorter)`);
  }

  const byKey = new Map<string, { calls: number; ok: number; failures: Map<string, number> }>();
  let total = 0;
  let totalOk = 0;
  for (const cell of cells) {
    const key = `${cell.tool}:${cell.action}`;
    let row = byKey.get(key);
    if (!row) {
      row = { calls: 0, ok: 0, failures: new Map() };
      byKey.set(key, row);
    }
    row.calls += cell.n;
    total += cell.n;
    if (cell.outcome === 'ok') {
      row.ok += cell.n;
      totalOk += cell.n;
    } else {
      row.failures.set(cell.outcome, (row.failures.get(cell.outcome) ?? 0) + cell.n);
    }
  }

  if (total === 0) {
    lines.push(
      'No tool calls recorded in this window. A call is recorded when it finishes, so this one is not counted yet.'
    );
  } else {
    lines.push(`${total} calls, ${pct(totalOk, total)} ok. Outcomes other than ok: invalid_args (failed validation), refused_owner, blocked_taint, queued_approval, error, unknown_tool, unknown_action.`);
    lines.push('');
    lines.push('tool:action | calls | ok | not ok');
    const sorted = [...byKey.entries()].sort((a, b) => b[1].calls - a[1].calls);
    for (const [key, row] of sorted.slice(0, 25)) {
      const fails = [...row.failures.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, n]) => `${outcome} ${n}`)
        .join(', ');
      lines.push(`${key} | ${row.calls} | ${pct(row.ok, row.calls)} | ${fails || '-'}`);
    }
    if (sorted.length > 25) lines.push(`(+${sorted.length - 25} more tool:actions)`);

    const failures = ledgerTopFailures(since, 8);
    if (failures.length > 0) {
      lines.push('');
      lines.push('Top failure causes:');
      for (const f of failures) {
        let cause = '';
        if (f.errorClass) cause = ` - ${f.errorClass}`;
        lines.push(`- ${f.tool}:${f.action} ${f.outcome}${cause} (${f.n})`);
      }
    }
  }

  const called = ledgerCapabilitiesCalled(since);
  // Only tools the model is actually offered: internal plumbing (e.g. `variable`) can't be
  // "never used" by it (Artie asked what `variable` was).
  const never = registryToTools(capabilityRegistry.list())
    .map((t) => t.function.name)
    .filter((name) => !called.has(name))
    .sort();
  lines.push('');
  // "Never called" means little until the ledger covers most of the window (Artie saw 65 of 65
  // tools "never called" an hour after it shipped).
  const coveredMs = now - Math.max(since, firstTs ?? now);
  const windowMs = now - since;
  if (coveredMs < windowMs / 2) {
    lines.push(
      `Never-called list skipped: the ledger only covers ${Math.round(coveredMs / 3_600_000)}h of this ${label} window, too short to say a tool is unused.`
    );
  } else if (never.length === 0) {
    lines.push(`Every registered tool was called at least once in the last ${label}.`);
  } else {
    lines.push(`Never called in the last ${label} (${never.length}): ${never.join(', ')}`);
  }
  return lines.join('\n');
}

// ── errors: LLM calls + tool calls, from the DB, with the definition stated ─

/**
 * What "errors" means, in one place. Both numbers come from the database, so a restart does
 * not zero them, and the LLM-call rate uses the same rows and the same success flag as the
 * "N% API errors" figure the distress monitor puts in your own context (distress.ts
 * getApiErrorRate: model_usage_stats, success = 0, but only over the last hour).
 *
 * The old version read the in-memory Prometheus counters, which (a) reset on restart and
 * (b) never counted a failed LLM call at all (recordApiCall only runs on the success path),
 * so it printed "no errors" while the DB showed failures.
 */
export function errorsReport(windowMinutes: number, now: number = Date.now()): string {
  const db = getSyncDb();
  const label = describeWindow(windowMinutes);
  const lines: string[] = [`## Errors, last ${label}`, ''];

  const llm = db.get<{ failed: number | null; total: number }>(
    `SELECT SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total
     FROM model_usage_stats WHERE timestamp > datetime('now', ?)`,
    [`-${windowMinutes} minutes`]
  );
  const failed = llm?.failed ?? 0;
  const llmTotal = llm?.total ?? 0;
  lines.push(`**LLM calls:** ${failed} failed of ${llmTotal} (${pct(failed, llmTotal)})`);
  if (failed > 0) {
    const kinds = db.all<{ error_type: string | null; n: number }>(
      `SELECT error_type, COUNT(*) AS n FROM model_usage_stats
       WHERE success = 0 AND timestamp > datetime('now', ?)
       GROUP BY error_type ORDER BY n DESC LIMIT 5`,
      [`-${windowMinutes} minutes`]
    );
    for (const k of kinds) lines.push(`- ${k.error_type || 'unknown'}: ${k.n}`);
  }

  const since = now - windowMinutes * 60 * 1000;
  const cells = ledgerCounts(since);
  // Failures are things that went wrong; policy stops (refused / taint-blocked / queued for
  // approval) are the system working as designed, so they are counted on their own line.
  const POLICY_STOPS = new Set(['refused_owner', 'blocked_taint', 'queued_approval']);
  let toolTotal = 0;
  let policyStops = 0;
  const bad = new Map<string, number>();
  for (const cell of cells) {
    toolTotal += cell.n;
    if (POLICY_STOPS.has(cell.outcome)) {
      policyStops += cell.n;
    } else if (cell.outcome !== 'ok') {
      const key = `${cell.tool}:${cell.action} ${cell.outcome}`;
      bad.set(key, (bad.get(key) ?? 0) + cell.n);
    }
  }
  let toolBad = 0;
  for (const n of bad.values()) toolBad += n;
  lines.push('');
  lines.push(`**Tool calls:** ${toolBad} failed of ${toolTotal} (${pct(toolBad, toolTotal)}), plus ${policyStops} policy stops (refused / taint-blocked / queued for approval)`);
  for (const [key, n] of [...bad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    lines.push(`- ${key}: ${n}`);
  }
  if (toolTotal > 0) lines.push('(use action "tools" for the per-tool table and causes)');

  lines.push('');
  lines.push(
    '_Counts: LLM calls = model_usage_stats rows (success flag), the same source as the distress "API errors" figure in your context (that one only looks at the last hour). Tool calls = the persisted tool-call ledger. Neither resets on restart._'
  );
  return lines.join('\n');
}

// Parse Prometheus metrics text format
function parsePrometheusMetrics(metricsText: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = metricsText.split('\n');

  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;

    // Parse metric line: metric_name{labels} value
    const match = line.match(/^([a-z_]+)(\{[^}]*\})?\s+(.+)$/);
    if (match) {
      const [, name, labels, value] = match;
      if (!result[name]) result[name] = [];
      result[name].push({
        labels: labels || '',
        value: parseFloat(value),
      });
    }
  }

  return result;
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Format duration
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

export const selfStatsCapability: RegisteredCapability = {
  name: 'self-stats',
  emoji: '📊',
  actions: {
    overview: { effect: 'read' },
    costs: { effect: 'read' },
    capabilities: { effect: 'read' },
    health: { effect: 'read' },
    errors: {
      effect: 'read',
      params: {
        timeRange: { type: 'string', description: 'Window, e.g. 1h, 24h, 7d (default 24h)' },
      },
    },
    // Aggregate per tool, no user ids, params or results: open like errors/capabilities.
    tools: {
      effect: 'read',
      params: {
        timeRange: { type: 'string', description: 'Window, e.g. 24h, 7d, 30d (default 7d)' },
      },
    },
    banlist: { effect: 'read' }, // a public moderation record by design
    // His own live prompt versions + recent changes + his own self-notes (scoped like memory).
    rules: { effect: 'read' },
    top_spenders: {
      effect: 'read', // a public leaderboard by design
      params: { limit: { type: 'integer', description: 'How many spenders to list (default 10, max 25)' } },
    },
    user_costs: {
      effect: 'read',
      who: 'owner', // one named person's spend
      params: {
        user_id: { type: 'string', description: 'Discord user id (defaults to whoever is asking)' },
      },
    },
  },
  supportedActions: [
    'overview',
    'costs',
    'capabilities',
    'health',
    'errors',
    'tools',
    'user_costs',
    'top_spenders',
    'banlist',
    'rules',
  ],
  description: `Check your own stats, health, and metrics — including what specific users have cost in LLM credits. Use this to understand how you're doing.

Actions:
- overview: Quick summary of everything
- costs: API costs and token usage today
- capabilities: Which capabilities you've used most
- health: Memory, CPU, uptime
- errors: Failed LLM calls and failed tool calls over a window (default 24h, timeRange e.g. "7d"), from the database, so a restart does not reset it. States what it counts.
- tools: Your tool-call ledger over a window (default 7d): per tool:action calls, ok %, failure outcomes (invalid args, refused, taint-blocked, queued for approval, errors, unknown tool/action), top failure causes, and tools never called. Use when asked which tools you avoid or which calls fail.
- user_costs: How much a specific user has cost in credits (lifetime, today, rank, worst days). Defaults to whoever is asking. Use when someone asks "how much money have I cost?", "what's my bill?", "how much have I spent?"
- banlist: Who is currently banned from talking to you, and since when. Use when anyone asks who's banned / the banlist. Opt-outs are never listed.
- rules: Which version of your rules is live: every database prompt's version (these override the code copies), what changed in the last 30 days (lines removed and now), and your own notes that still echo a removed line, by id, so you can fix or forget them. Use when your notes and your prompt seem to disagree, or you're unsure a rule still holds.
- top_spenders: Leaderboard of the biggest credit consumers. Use when someone asks who costs the most / top spenders / biggest credit users.

Use this when you want to reflect on your performance, check if something's wrong, or answer questions about who is costing what.`,
  requiredParams: [],
  examples: [
    '<capability name="self-stats" action="overview" />',
    '<capability name="self-stats" action="costs" />',
    '<capability name="self-stats" action="capabilities" />',
    '<capability name="self-stats" action="health" />',
    '<capability name="self-stats" action="errors" data=\'{"timeRange":"24h"}\' />',
    '<capability name="self-stats" action="tools" data=\'{"timeRange":"7d"}\' />',
    '<capability name="self-stats" action="user_costs" />',
    '<capability name="self-stats" action="user_costs" data=\'{"user_id":"703107274293641266"}\' />',
    '<capability name="self-stats" action="top_spenders" data=\'{"limit":10}\' />',
  ],

  handler: async (params: any, _content?: string, context?: CapabilityContext) => {
    const { action = 'overview' } = params as SelfStatsParams;

    logger.info(`📊 Self-stats: ${action}`);

    if (action === 'banlist') return banlistReport();
    if (action === 'rules') return loadRulesReport(context?.userId ?? 'unknown-user', context?.guildId);

    // DB-backed actions don't need the metrics registry — handle them first.
    if (action === 'errors' || action === 'tools') {
      try {
        if (action === 'tools') {
          return toolsReport(parseWindowMinutes(params.timeRange, 7 * 24 * 60));
        }
        return errorsReport(parseWindowMinutes(params.timeRange, 24 * 60));
      } catch (error: any) {
        logger.error(`Self-stats ${action} error:`, error);
        return `Error running ${action}: ${error.message}`;
      }
    }

    if (action === 'user_costs' || action === 'top_spenders') {
      try {
        const db = getSyncDb();
        if (action === 'user_costs') {
          const targetId = params.user_id || params.userId;
          if (!targetId || targetId === 'unknown-user') {
            return 'No user id available — pass user_id explicitly.';
          }
          return userCostsReport(db, String(targetId));
        }
        return topSpendersReport(
          db,
          Number(params.limit) || 10,
          context?.guildId ?? null,
          String(context?.userId ?? '')
        );
      } catch (error: any) {
        logger.error(`Self-stats ${action} error:`, error);
        return `Error running ${action}: ${error.message}`;
      }
    }

    try {
      const metricsText = await metricsRegistry.metrics();
      const metrics = parsePrometheusMetrics(metricsText);

      switch (action) {
        case 'overview': {
          const lines: string[] = ['## Artie Self-Stats Overview\n'];

          // Memory (metrics have artie_ prefix)
          const heapUsed = metrics['artie_nodejs_heap_size_used_bytes']?.[0]?.value;
          const heapTotal = metrics['artie_nodejs_heap_size_total_bytes']?.[0]?.value;
          if (heapUsed && heapTotal) {
            lines.push(`**Memory:** ${formatBytes(heapUsed)} / ${formatBytes(heapTotal)} heap`);
          }

          // Uptime
          const uptime = metrics['artie_process_start_time_seconds']?.[0]?.value;
          if (uptime) {
            const uptimeSeconds = Date.now() / 1000 - uptime;
            lines.push(`**Uptime:** ${formatUptime(uptimeSeconds)}`);
          }

          // API Costs today
          const dailyCosts = metrics['artie_daily_cost_dollars'] || [];
          const totalDailyCost = dailyCosts.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Today's API Cost:** $${totalDailyCost.toFixed(4)}`);

          // Total API calls
          const apiCalls = metrics['artie_api_calls_total'] || [];
          const totalCalls = apiCalls.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**API Calls:** ${totalCalls}`);

          // Capability usage
          const capUsage = metrics['artie_capability_usage_total'] || [];
          const totalCapCalls = capUsage.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Capability Executions:** ${totalCapCalls}`);

          // Messages processed
          const messages = metrics['artie_messages_processed_total'] || [];
          const totalMessages = messages.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`**Messages Processed:** ${totalMessages}`);

          return lines.join('\n');
        }

        case 'costs': {
          const lines: string[] = ['## API Costs & Token Usage\n'];

          // Daily costs by model
          const dailyCosts = metrics['artie_daily_cost_dollars'] || [];
          if (dailyCosts.length > 0) {
            lines.push('**Today by Model:**');
            for (const m of dailyCosts) {
              const model = m.labels.match(/model="([^"]+)"/)?.[1] || 'unknown';
              lines.push(`- ${model}: $${m.value.toFixed(4)}`);
            }
            const total = dailyCosts.reduce((sum: number, m: any) => sum + m.value, 0);
            lines.push(`\n**Total Today:** $${total.toFixed(4)}`);
          } else {
            lines.push('No API costs recorded yet today.');
          }

          // Token usage
          const inputTokens = metrics['artie_tokens_input_total'] || [];
          const outputTokens = metrics['artie_tokens_output_total'] || [];
          const totalInput = inputTokens.reduce((sum: number, m: any) => sum + m.value, 0);
          const totalOutput = outputTokens.reduce((sum: number, m: any) => sum + m.value, 0);
          lines.push(`\n**Tokens Used:**`);
          lines.push(`- Input: ${totalInput.toLocaleString()}`);
          lines.push(`- Output: ${totalOutput.toLocaleString()}`);
          lines.push(`- Total: ${(totalInput + totalOutput).toLocaleString()}`);

          return lines.join('\n');
        }

        case 'capabilities': {
          const lines: string[] = ['## Capability Usage\n'];

          const capUsage = metrics['artie_capability_usage_total'] || [];
          if (capUsage.length === 0) {
            return 'No capability usage recorded yet since last restart.';
          }

          // Group by capability
          const byCapability: Record<string, { success: number; error: number }> = {};
          for (const m of capUsage) {
            const cap = m.labels.match(/capability="([^"]+)"/)?.[1] || 'unknown';
            const status = m.labels.match(/status="([^"]+)"/)?.[1] || 'unknown';
            if (!byCapability[cap]) byCapability[cap] = { success: 0, error: 0 };
            if (status === 'success') byCapability[cap].success += m.value;
            else byCapability[cap].error += m.value;
          }

          // Sort by total usage
          const sorted = Object.entries(byCapability)
            .map(([name, stats]) => ({ name, ...stats, total: stats.success + stats.error }))
            .sort((a, b) => b.total - a.total);

          lines.push('**Most Used:**');
          for (const cap of sorted.slice(0, 10)) {
            let errorRate: string;
            if (cap.total > 0) {
              errorRate = ((cap.error / cap.total) * 100).toFixed(0);
            } else {
              errorRate = '0';
            }
            let errorNote: string;
            if (cap.error > 0) {
              errorNote = ` (${errorRate}% errors)`;
            } else {
              errorNote = '';
            }
            lines.push(`- ${cap.name}: ${cap.total}${errorNote}`);
          }

          return lines.join('\n');
        }

        case 'health': {
          const lines: string[] = ['## System Health\n'];

          // Memory details (metrics have artie_ prefix)
          const heapUsed = metrics['artie_nodejs_heap_size_used_bytes']?.[0]?.value;
          const heapTotal = metrics['artie_nodejs_heap_size_total_bytes']?.[0]?.value;
          const external = metrics['artie_nodejs_external_memory_bytes']?.[0]?.value;
          const rss = metrics['artie_process_resident_memory_bytes']?.[0]?.value;

          lines.push('**Memory:**');
          if (heapUsed) lines.push(`- Heap Used: ${formatBytes(heapUsed)}`);
          if (heapTotal) lines.push(`- Heap Total: ${formatBytes(heapTotal)}`);
          if (external) lines.push(`- External: ${formatBytes(external)}`);
          if (rss) lines.push(`- RSS: ${formatBytes(rss)}`);

          // Uptime
          const uptime = metrics['artie_process_start_time_seconds']?.[0]?.value;
          if (uptime) {
            const uptimeSeconds = Date.now() / 1000 - uptime;
            lines.push(`\n**Uptime:** ${formatUptime(uptimeSeconds)}`);
          }

          // Event loop lag
          const eventLoopLag = metrics['artie_nodejs_eventloop_lag_seconds']?.[0]?.value;
          if (eventLoopLag !== undefined) {
            const lagMs = eventLoopLag * 1000;
            let status: string;
            if (lagMs < 100) {
              status = '✅';
            } else if (lagMs < 500) {
              status = '⚠️';
            } else {
              status = '🔴';
            }
            lines.push(`\n**Event Loop Lag:** ${lagMs.toFixed(1)}ms ${status}`);
          }

          // Active handles/requests
          const activeHandles = metrics['artie_nodejs_active_handles_total']?.[0]?.value;
          const activeRequests = metrics['artie_nodejs_active_requests_total']?.[0]?.value;
          if (activeHandles !== undefined) {
            lines.push(`\n**Active Handles:** ${activeHandles}`);
          }
          if (activeRequests !== undefined) {
            lines.push(`**Active Requests:** ${activeRequests}`);
          }

          return lines.join('\n');
        }

        // 'errors' and 'tools' are DB-backed and handled above (errorsReport, toolsReport).

        default:
          return `Unknown action: ${action}. Use: overview, costs, capabilities, health, errors, tools, user_costs, top_spenders`;
      }
    } catch (error: any) {
      logger.error('Self-stats error:', error);
      return `Error checking stats: ${error.message}`;
    }
  },
};

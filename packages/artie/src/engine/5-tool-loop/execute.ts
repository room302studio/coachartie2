import { logger } from '../../shared/logger.js';
import { capabilityRegistry, resolveToolCall } from './registry.js';
import { gatesFor } from './tool-policy.js';
import { robustExecutor } from './retry.js';
import { jobTracker } from '../1-intake/job-tracker.js';
import { toCallNotation } from './mode.js';
import { looksLikeToolFailure, writeLedgerRow } from './tool-ledger.js';
import { ExtractedCapability, OrchestrationContext } from '../2-turn/types.js';

// =====================================================
// NATIVE TOOL EXECUTION
// =====================================================

// =====================================================
// TAINT TRACKING FOR EXTERNAL CONTENT SECURITY
// Prevents prompt injection from external sources (web, etc.)
// from hijacking dangerous capabilities (shell, filesystem, git)
// =====================================================

// Every name in these three sets is a REGISTERED CANONICAL tool name (taint-tracking.test.ts
// asserts it). Old merged names (shell, git, …) are resolved through resolveToolCall before
// these sets are consulted, so they never need listing here.

// Capabilities that fetch external untrusted content - executing these taints the context
export const TAINTING_CAPABILITIES = new Set([
  'http', // Raw HTTP fetches
  'web', // Web browsing + web search (the <websearch> shortcut resolves to web:search)
  'n8n_browser', // Browser automation (registered name; was listed as 'n8n-browser', which never matched)
  // Security audit 2026-10-26 (sec-abuse.md, batch 2): reading any of these pulls
  // attacker-controlled text into the turn (a GitHub issue body, a reddit thread, a wiki
  // page) just as much as a raw http/web fetch does, even though the read itself is open
  // (approval-gate.ts only gates the write actions on these tools).
  'github',
  'reddit',
  'mediawiki',
  // discord-channels, discord-forums and discord-search deliberately do NOT taint (EJ,
  // 2026-11-23: "skip the taint"; search followed on 2026-11-24), so Artie can find or read a
  // message and act on it in the same turn. They return the same kind of server text he
  // already sees in channel history, audience-gated; his Discord writes never mass-ping and
  // threads/posts stay Room 302-scoped.
]);

// Which actions are blocked once the turn is tainted is no longer a list here: it is derived
// from each tool's declared `effect` (anything beyond read/own), in tool-policy.ts. Until
// 2026-11-17 two hand-kept tables did this; the filesystem exemptions named actions that
// didn't exist (read/list instead of read_file/list_directory), and hermes was missing.

/**
 * Check if a capability is blocked due to taint
 * Returns error message if blocked, null if allowed
 */
function checkTaintBlock(
  capability: ExtractedCapability,
  context: OrchestrationContext | undefined
): string | null {
  if (!context?.taintedByExternalContent) {
    return null; // Not tainted, allow everything
  }

  // Canonical name + action (an old name like shell/git maps to sandbox first).
  const resolved = resolveToolCall(capability.name, capability.action, undefined, { log: false });
  const capName = String(resolved.name).toLowerCase();
  const declared = capabilityRegistry.list().find((c) => c.name === capName)?.actions;
  if (!gatesFor(declared, String(resolved.action).toLowerCase()).dangerousWhenTainted) {
    return null; // read/own actions (or undeclared ones) stay available
  }

  // Ledger: the registry is never reached for a blocked call, so this is its one row. The
  // native call site calls checkTaintBlock once per call.
  writeLedgerRow({
    tool: capName,
    action: String(resolved.action).toLowerCase(),
    outcome: 'blocked_taint',
    errorClass: `tainted_by:${context.taintSource ?? 'unknown'}`,
    userId: context.userId,
    guildId: context.discord_context?.guildId,
  });

  // Block the capability
  return (
    `🛡️ SECURITY: Capability "${capability.name}:${capability.action}" blocked. ` +
    `Context is tainted by external content from "${context.taintSource}". ` +
    `Dangerous operations are disabled to prevent prompt injection attacks. ` +
    `Safe read-only actions are still allowed.`
  );
}

/**
 * Check if executing a capability should taint the context
 */
function shouldTaintContext(capability: ExtractedCapability): boolean {
  const { name } = resolveToolCall(capability.name, capability.action, undefined, { log: false });
  return TAINTING_CAPABILITIES.has(String(name).toLowerCase());
}

/** Cap on one tool result fed back to the model (a fetched page can be 100k+ chars). */
export const NATIVE_TOOL_RESULT_MAX_CHARS = 12_000;

function toolResultText(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') {
    return data;
  }
  return JSON.stringify(data);
}

/**
 * Catches a class of bug found 2026-10-26: several tool handlers (scratchpad, system_memory,
 * stripe, memory's old pinMemory, …) catch their own failures internally and RETURN a string
 * describing the error instead of throwing. Because they didn't throw, robustExecutor reports
 * success=true, so this result would otherwise go to the model with no "Error:" prefix at
 * all — identical in shape to a real success. A failure that looks like a success is worse
 * than a thrown one: the model has no signal to retry or explain, so it just repeats the
 * failed intent back to the user as if it had worked.
 *
 * Deliberately narrow and prefix-anchored (checked against the START of the string) so it
 * doesn't flag ordinary content that happens to mention "error" or a TaskStop emoji mid-text —
 * only the small set of shapes real handlers actually emit for "this call itself failed":
 *   - a leading ❌ (memory, email-drafting, autonomous, sandbox's edit errors, …)
 *   - "<Words> error: " at the very start (scratchpad, goals, tasks, context, diagnose, …)
 *   - "Error: " at the very start (sandbox's edit/search, pairing, autonomous, …)
 *   - a JSON object/array whose top-level `success` field is false (system_memory, stripe,
 *     discord reaction/poll/moderation, http, …)
 */
// The implementation moved to tool-ledger.ts (the registry classifies outcomes with it and
// can't import this file); re-exported so existing importers keep working.
export { looksLikeToolFailure };

/**
 * Execute ONE native tool call (wave 8): runToolLoop's executeTool in run-turn.ts.
 *
 *   resolveToolCall (TOOL_ALIASES: an old name like shell/todo runs its canonical tool)
 *   → taint block (DANGEROUS_WHEN_TAINTED after a web/http fetch in this turn)
 *   → job tracker emoji (the gateway's "using <tool>" reactions)
 *   → robustExecutor.executeWithRetry (retry wrapper → registry.execute: ACTION_ALIASES,
 *     param validation, scheduler/memory userId injection, channel/guild context)
 *   → context.capabilities/results (autoSingLyricSheet and failure logs read them)
 *   → taint set when the tool fetched external content.
 * Never throws for a tool failure: the failure comes back as "Error: ..." text so the model
 * can recover. Registry hints that quote <capability .../> syntax are rewritten as call
 * notation first.
 */
export async function executeNativeToolCall(
  context: OrchestrationContext,
  invocation: { name: string; action?: string; content?: string; params: Record<string, unknown> }
): Promise<string> {
  // `confirmed: true` is the approval-gate's owner-bypass flag (approval-gate.ts's
  // isOwnerConfirmed). It must ONLY ever be set by approvals.ts replaying an already-approved
  // call — never by a live model tool call, even the owner's own, or Artie could decide on its
  // own to add it and skip the gate without EJ actually having said yes. Stripped here, at the
  // one place every native tool call enters, so the model can't set it no matter what it puts
  // in the arguments.
  const { confirmed: _ignoredConfirmed, ...sanitizedParams } = invocation.params ?? {};
  const resolved = resolveToolCall(invocation.name, invocation.action ?? '', sanitizedParams);
  const capability: ExtractedCapability = {
    name: resolved.name,
    action: resolved.action,
    params: resolved.params ?? {},
    content: invocation.content,
    priority: context.capabilities.length,
  };
  context.capabilities.push(capability);

  const taintBlock = checkTaintBlock(capability, context);
  if (taintBlock) {
    logger.warn(`🛡️ TAINT BLOCK: ${capability.name}:${capability.action} blocked (native tool call)`);
    context.results.push({
      capability,
      success: false,
      error: taintBlock,
      timestamp: new Date().toISOString(),
    });
    context.currentStep++;
    return `Error: ${taintBlock}`;
  }

  try {
    const emoji = capabilityRegistry.get(capability.name, capability.action)?.emoji;
    if (emoji) jobTracker.trackCapabilityExecution(context.messageId, emoji);
  } catch {
    // unknown tool or action: the registry reports it below
  }

  const robust = await robustExecutor.executeWithRetry(
    {
      name: capability.name,
      action: capability.action,
      content: capability.content || '',
      params: capability.params,
    },
    {
      userId: context.userId,
      messageId: context.messageId,
      traceId: context.traceId || undefined,
      channelId: context.discord_context?.channelId,
      guildId: context.discord_context?.guildId,
    }
    // Attempts: the executor's per-tool default (installs get 1), not a hardcoded 3 (Codex crew).
  );

  context.results.push({
    capability,
    success: robust.success,
    data: robust.data,
    error: robust.error,
    timestamp: robust.timestamp,
  });
  context.currentStep++;

  if (robust.success && shouldTaintContext(capability)) {
    context.taintedByExternalContent = true;
    context.taintSource = `${capability.name}:${capability.action}`;
    logger.warn(`🛡️ TAINT SET: context tainted by ${context.taintSource} (native tool call)`);
  }

  let successText: string | null;
  if (robust.success) {
    successText = toolResultText(robust.data);
  } else {
    successText = null;
  }
  let text: string;
  if (successText !== null && !looksLikeToolFailure(successText)) {
    text = successText;
  } else {
    let errorMsg: string;
    if (robust.success) {
      errorMsg = successText || 'the tool failed';
    } else {
      errorMsg = robust.error || 'the tool failed';
    }
    text = `Error: ${toCallNotation(errorMsg)}`;
  }
  let result: string;
  if (text.length > NATIVE_TOOL_RESULT_MAX_CHARS) {
    result = `${text.slice(0, NATIVE_TOOL_RESULT_MAX_CHARS)}\n[… truncated, ${text.length - NATIVE_TOOL_RESULT_MAX_CHARS} more chars]`;
  } else {
    result = text;
  }
  return result;
}

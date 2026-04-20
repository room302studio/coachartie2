/**
 * Hermes Agent Capability
 *
 * Delegates ops/terminal work to Hermes Agent (Nous Research).
 * Hermes runs the Hermes 4 405B model and has terminal access to the VPS.
 *
 * Use cases:
 * - System administration tasks
 * - Multi-step ops workflows
 * - Running scripts and checking logs
 * - OSINT scanning and data gathering
 * - Anything that needs shell access + reasoning
 *
 * Artie handles conversation, Hermes handles execution.
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

const HERMES_API_URL = 'http://127.0.0.1:47400';
const HERMES_TIMEOUT = 120_000; // 2 min — ops tasks can take time

interface HermesParams {
  action: string;
  task?: string;
  command?: string;
  message?: string;
  [key: string]: unknown;
}

async function fetchHermes(path: string, body: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT);

  try {
    const res = await fetch(`${HERMES_API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'Hermes timed out (2 min limit)' };
    }
    return { success: false, error: `Hermes unavailable: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleHermes(
  params: HermesParams,
  content?: string,
  context?: CapabilityContext,
): Promise<string> {
  const { action, task, command, message } = params;

  switch (action) {
    case 'execute':
    case 'run':
    case 'do': {
      // Delegate an ops task to Hermes
      const taskText = task || command || content || '';
      if (!taskText) return 'No task specified. Tell me what to do.';

      logger.info(`[hermes] Delegating task: ${taskText.slice(0, 100)}`);

      const result = await fetchHermes('/api/task', {
        task: taskText,
        context: context?.userId ? `Requested by user ${context.userId} via Coach Artie` : '',
        max_turns: 15,
      });

      if (!result.success) {
        return `Hermes error: ${result.error}`;
      }

      return `**Hermes completed** (${result.api_calls || '?'} steps):\n\n${result.response}`;
    }

    case 'ask':
    case 'chat': {
      // Quick question to Hermes (no tool use)
      const msg = message || content || '';
      if (!msg) return 'What should I ask Hermes?';

      const result = await fetchHermes('/api/chat', { message: msg });

      if (!result.success) {
        return `Hermes error: ${result.error}`;
      }

      return `**Hermes says:** ${result.response}`;
    }

    case 'status':
    case 'health': {
      try {
        const res = await fetch(`${HERMES_API_URL}/api/status`, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as { status: string; model: string; capabilities: string[] };
        return `Hermes is **${data.status}** — model: ${data.model}, capabilities: ${data.capabilities?.join(', ')}`;
      } catch {
        return 'Hermes is **offline** or not responding.';
      }
    }

    default:
      return `Unknown hermes action: "${action}". Use: execute, ask, or status.`;
  }
}

export const hermesCapability: RegisteredCapability = {
  name: 'hermes',
  emoji: '⚕',
  supportedActions: ['execute', 'run', 'do', 'ask', 'chat', 'status', 'health'],
  description:
    'Delegate ops and terminal work to Hermes Agent (Nous Research, Hermes 4 405B). ' +
    'Hermes has shell access and can run multi-step tasks autonomously. ' +
    'Use for system admin, script execution, log checking, OSINT scanning.',
  handler: handleHermes,
  requiredParams: ['action'],
  examples: [
    '<capability name="hermes" action="execute">Check disk space and clean up old docker images</capability>',
    '<capability name="hermes" action="ask">What\'s the status of the skywatch scanner?</capability>',
    '<capability name="hermes" action="status" />',
  ],
};

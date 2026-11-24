/**
 * Tool execution plumbing in 5-tool-loop/execute-tool-call.ts and capabilities/registry.ts,
 * against the REAL code.
 *
 * Wave 11 folded six files in here; the XML chain cases (substituteKeys, the {{result}} keys,
 * the DB-backed {{var}} pass) went with the XML loop.
 *
 *   atomic/action-alias-mapper         -> "registry: action aliases"
 *   atomic/error-message-builder       -> "registry: action error messages"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { executeNativeToolCall } from '../../src/engine/5-tool-loop/execute-tool-call.js';
import { looksLikeToolFailure } from '../../src/engine/capabilities/ledger.js';
import {
  CapabilityRegistry,
  capabilityRegistry,
  type RegisteredCapability,
} from '../../src/engine/capabilities/registry.js';
import type { OrchestrationContext } from '../../src/engine/2-turn/types.js';

// ---------------------------------------------------------------------------------------------
// registry: action aliases and action errors (fresh registries with stub tools, not the singleton)
// ---------------------------------------------------------------------------------------------

const FS_ACTIONS = ['read_file', 'write_file', 'create_directory', 'list_directory', 'exists', 'delete'];
const stub = (name: string, supportedActions: string[]): RegisteredCapability => ({
  name,
  supportedActions,
  handler: async (params: any) => `ran ${name}:${params.action}`,
});

let registry: CapabilityRegistry;
beforeAll(() => {
  registry = new CapabilityRegistry();
  registry.register(stub('filesystem', FS_ACTIONS));
  registry.register(stub('memory', ['remember', 'recall']));
});

// Was atomic/action-alias-mapper.test.ts. Two real alias tables exist: ACTION_ALIASES (memory
// only) silently rewrites the action inside execute(); generateActionError's map only SUGGESTS.
// The copy's mkdir/ls/rm entries exist in neither and have no case here.
describe('registry: action aliases', () => {
  it('suggests the file actions for write/read', () => {
    expect(registry.generateActionError('filesystem', 'write')).toContain("Did you mean 'write_file'?");
    expect(registry.generateActionError('filesystem', 'read')).toContain("Did you mean 'read_file'?");
  });

  it('runs memory synonyms as the real action, and suggests recall for search/find', async () => {
    expect(await registry.execute('memory', 'store')).toBe('ran memory:remember');
    expect(await registry.execute('memory', 'save')).toBe('ran memory:remember');
    expect(await registry.execute('memory', 'get')).toBe('ran memory:recall');
    expect(registry.generateActionError('memory', 'search')).toContain("Did you mean 'recall'?");
    expect(registry.generateActionError('memory', 'find')).toContain("Did you mean 'recall'?");
  });

  it('suggests the directory/delete/exists actions', () => {
    expect(registry.generateActionError('filesystem', 'create')).toContain("Did you mean 'create_directory'?");
    expect(registry.generateActionError('filesystem', 'list')).toContain("Did you mean 'list_directory'?");
    expect(registry.generateActionError('filesystem', 'remove')).toContain("Did you mean 'delete'?");
    expect(registry.generateActionError('filesystem', 'check')).toContain("Did you mean 'exists'?");
  });

  it('suggestions are case-insensitive; the silent rewrite is not', async () => {
    for (const a of ['WRITE', 'Write', 'WrItE']) {
      expect(registry.generateActionError('filesystem', a)).toContain("Did you mean 'write_file'?");
    }
    await expect(registry.execute('memory', 'STORE')).rejects.toThrow();
  });

  it('a real action runs unchanged; an unknown one gets no suggestion', async () => {
    expect(await registry.execute('memory', 'remember')).toBe('ran memory:remember');
    expect(registry.generateActionError('filesystem', 'unknown_action')).not.toContain('Did you mean');
  });

  it('an alias only fires when the tool has the target action', async () => {
    const r = new CapabilityRegistry();
    r.register(stub('memory', ['recall', 'forget']));
    await expect(r.execute('memory', 'store')).rejects.toThrow();
    expect(await r.execute('memory', 'retrieve')).toBe('ran memory:recall');
  });

  it('the whole memory alias table', async () => {
    const table: Array<[string, string]> = [
      ['store', 'remember'],
      ['save', 'remember'],
      ['add', 'remember'],
      ['retrieve', 'recall'],
      ['get', 'recall'],
    ];
    for (const [alias, real] of table) {
      expect(await registry.execute('memory', alias)).toBe(`ran memory:${real}`);
    }
  });
});

// Was atomic/error-message-builder.test.ts (an ErrorMessageBuilder that only existed in the
// test, with emoji the real messages don't have).
describe('registry: action error messages', () => {
  it('suggests the alias, with the full action list', () => {
    expect(registry.generateActionError('filesystem', 'write')).toBe(
      "Capability 'filesystem' does not support action 'write'. Did you mean 'write_file'? Supported actions: read_file, write_file, create_directory, list_directory, exists, delete"
    );
  });

  it('falls back to a substring/prefix match when there is no alias', () => {
    expect(registry.generateActionError('filesystem', 'wri')).toContain("Did you mean 'write_file'?");
    expect(() => registry.get('filesystem', 'wri')).toThrow("Did you mean 'write_file'?");
  });

  it('a short prefix finds create_directory', () => {
    expect(registry.generateActionError('filesystem', 'cre')).toContain('create_directory');
  });

  it('no good match: the plain message', () => {
    const error = registry.generateActionError('filesystem', 'unknown_xyz');
    expect(error).not.toContain('Did you mean');
    expect(error).toContain('does not support action');
    expect(error).toContain('Supported actions:');
  });

  it('names the capability', () => {
    expect(registry.generateActionError('memory', 'xyz')).toContain("Capability 'memory'");
  });

  it('lists every supported action', () => {
    expect(registry.generateActionError('filesystem', 'xyz')).toContain(
      'read_file, write_file, create_directory'
    );
  });

  it('a tool with no actions cannot exist; an unknown tool says not found', () => {
    // copy tested an empty action list; the registry refuses to register one.
    expect(() => new CapabilityRegistry().register(stub('test', []))).toThrow(
      'At least one supported action is required'
    );
    expect(registry.generateActionError('test', 'action')).toBe("Capability 'test' not found");
  });
});

/**
 * Loud fallbacks (2026-10-26): several real handlers catch their own failure and RETURN a
 * string describing it instead of throwing — scratchpad.ts, system-memory.ts, and (pre-fix)
 * memory.ts's pinMemory are the three concrete cases found in the audit. Because they don't
 * throw, executeNativeToolCall's robust.success is true and the un-prefixed string would go
 * straight to the model looking identical to a real success. looksLikeToolFailure is the
 * detector that catches that shape before it reaches the model.
 */
describe('looksLikeToolFailure: catching self-reported failures that never threw', () => {
  it('flags a leading ❌ (memory pinMemory pre-fix, email-drafting, autonomous, …)', () => {
    expect(looksLikeToolFailure('❌ Memory not found: 123')).toBe(true);
  });

  it('flags "<Words> error: " at the start (scratchpad.ts, goals.ts, context.ts, diagnose.ts)', () => {
    expect(looksLikeToolFailure('Scratchpad error: ENOENT no such file')).toBe(true);
    expect(looksLikeToolFailure('Diagnose error: boom')).toBe(true);
    expect(looksLikeToolFailure('Context error: boom')).toBe(true);
  });

  it('flags a bare "Error: " prefix (sandbox edit/search, pairing, autonomous)', () => {
    expect(looksLikeToolFailure('Error: something broke')).toBe(true);
  });

  it('flags JSON with a top-level success:false (system-memory.ts, stripe.ts, discord reaction/poll)', () => {
    expect(looksLikeToolFailure(JSON.stringify({ success: false, error: 'content required' }))).toBe(
      true
    );
  });

  it('does not flag JSON with success:true', () => {
    expect(looksLikeToolFailure(JSON.stringify({ success: true, id: 1 }))).toBe(false);
  });

  it('does not flag ordinary content that merely mentions "error" mid-sentence', () => {
    expect(looksLikeToolFailure('The user had an error at work yesterday, feeling better now.')).toBe(
      false
    );
  });

  it('does not flag a normal successful recall/remember confirmation', () => {
    expect(looksLikeToolFailure('✅ Remembered: "pizza" (ID: 5, importance: 5/10, tags: food)')).toBe(
      false
    );
  });

  it('does not flag an empty string (no data is not the same as a failure)', () => {
    expect(looksLikeToolFailure('')).toBe(false);
  });
});

/**
 * executeNativeToolCall is the actual integration point — looksLikeToolFailure above tests
 * the detector in isolation, this exercises the real path a model's tool call takes: a
 * handler that returns a self-reported failure string (no throw) must still come back to the
 * model prefixed with "Error:", exactly like a thrown one would.
 */
describe('executeNativeToolCall: a self-reported failure is never swallowed as a success', () => {
  function makeContext(userId = 'test-user'): OrchestrationContext {
    return {
      messageId: 'test-msg',
      userId,
      originalMessage: 'test',
      source: 'test',
      capabilities: [],
      results: [],
      currentStep: 0,
      respondTo: async () => {},
      capabilityFailureCount: new Map(),
    };
  }

  beforeAll(() => {
    capabilityRegistry.register({
      name: 'loud-fallback-stub',
      supportedActions: ['fail-quietly', 'succeed'],
      handler: async (params: any) => {
        if (params.action === 'fail-quietly') {
          // The scratchpad.ts / system-memory.ts shape: caught internally, returned as text,
          // never thrown.
          return 'Stub error: something went wrong internally';
        }
        return '✅ all good';
      },
    });
  });

  it('a caught-and-returned failure reaches the model prefixed with "Error:"', async () => {
    const context = makeContext();
    const out = await executeNativeToolCall(context, {
      name: 'loud-fallback-stub',
      action: 'fail-quietly',
      params: {},
    });
    expect(out.startsWith('Error:')).toBe(true);
    expect(out).toContain('Stub error: something went wrong internally');
  });

  it('a real success still passes through untouched', async () => {
    const context = makeContext();
    const out = await executeNativeToolCall(context, {
      name: 'loud-fallback-stub',
      action: 'succeed',
      params: {},
    });
    expect(out).toBe('✅ all good');
  });

  it("a model can't set confirmed:true itself to skip the approval gate", async () => {
    // stripe is gated for everyone (approval-gate.ts); even the owner needs `approvals:approve`
    // to actually confirm — a model-supplied `confirmed` param must be stripped before the
    // gate check, not trusted.
    const { OWNER_USER_ID } = await import('../../src/shared/config/owner.js');
    // Gates come from stripe's own declaration now, so the real tool must be registered.
    const { stripePaymentsCapability } = await import('../../src/engine/capabilities/money/stripe.js');
    if (!capabilityRegistry.has('stripe')) {
      capabilityRegistry.register(stripePaymentsCapability);
    }
    const context = makeContext(OWNER_USER_ID);
    const out = await executeNativeToolCall(context, {
      name: 'stripe',
      action: 'create_payment_link',
      params: { name: 'x', amount: 5, confirmed: true },
    });
    expect(out).toContain("needs EJ's approval");
  });
});

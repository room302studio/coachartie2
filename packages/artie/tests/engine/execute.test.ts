/**
 * Tool execution plumbing in 5-tool-loop/execute.ts and registry.ts, against the REAL code.
 *
 * Wave 11 folded six files in here. Five of them ("atomic" tests + the older
 * template-substitution.test.ts) tested local copies of logic that drifted from src; each of
 * their `it`s now pins what the real function does on the same axis. Where the copy asserted
 * behavior src never had, the case says so in a comment ("copy said … src does …").
 *
 *   substitute-keys.test.ts            -> "substituteKeys" (moved verbatim)
 *   atomic/template-substitution       -> "substituteKeys" + "GlobalVariableStore.substitute"
 *   template-substitution.test.ts      -> "substituteKeys" + "substituteTemplateVariables"
 *   atomic/variable-context-builder    -> "substituteTemplateVariables: the {{result}} keys"
 *   atomic/action-alias-mapper         -> "registry: action aliases"
 *   atomic/error-message-builder       -> "registry: action error messages"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { substituteKeys, capabilityExecutor } from '../../src/engine/5-tool-loop/execute.js';
import {
  CapabilityRegistry,
  type RegisteredCapability,
} from '../../src/engine/5-tool-loop/registry.js';
import { capabilityParser } from '../../src/engine/5-tool-loop/parse-tool-calls.js';
import { GlobalVariableStore } from '../../src/engine/5-tool-loop/variables.js';
import type { CapabilityResult, ExtractedCapability } from '../../src/engine/2-turn/types.js';

const subs = (o: Record<string, string>) => new Map(Object.entries(o));

// ---------------------------------------------------------------------------------------------
// substituteKeys: the local {{key}} pass
// ---------------------------------------------------------------------------------------------

// Wave 7 / ledger #11: {{key}} substitution treats the key and the value literally.
describe('substituteKeys', () => {
  it('a key containing . substitutes only itself', () => {
    const s = new Map([['a.b', 'X']]);
    expect(substituteKeys('{{a.b}} {{ a.b }} {{aZb}}', s)).toBe('X X {{aZb}}');
  });

  it('a key containing * is literal, not a quantifier', () => {
    const s = new Map([['n*', 'Y']]);
    expect(substituteKeys('{{n*}} {{nnn}} {{}}', s)).toBe('Y {{nnn}} {{}}');
  });

  it('values with $& or $1 are inserted verbatim', () => {
    const s = new Map([['result', 'costs $& and $1']]);
    expect(substituteKeys('got: {{result}}', s)).toBe('got: costs $& and $1');
  });

  it('the real keys still work', () => {
    const s = new Map([
      ['result', 'r'],
      ['result_1', 'r1'],
      ['memories', 'm'],
    ]);
    expect(substituteKeys('{{result}}/{{result_1}}/{{ memories }}', s)).toBe('r/r1/m');
  });

  // from atomic/template-substitution.test.ts
  it('substitutes a single variable', () => {
    expect(substituteKeys('Hello {{name}}', subs({ name: 'World' }))).toBe('Hello World');
  });

  it('substitutes multiple variables', () => {
    expect(
      substituteKeys('{{greeting}} {{name}}!', subs({ greeting: 'Hello', name: 'Coach Artie' }))
    ).toBe('Hello Coach Artie!');
  });

  it('leaves a missing variable unchanged', () => {
    expect(substituteKeys('Hello {{name}} and {{missing}}', subs({ name: 'World' }))).toBe(
      'Hello World and {{missing}}'
    );
  });

  it('allows whitespace inside the braces', () => {
    expect(
      substituteKeys('{{ name }} and {{  title  }}', subs({ name: 'Coach Artie', title: 'AI Assistant' }))
    ).toBe('Coach Artie and AI Assistant');
  });

  it('handles an empty template', () => {
    expect(substituteKeys('', subs({ name: 'test' }))).toBe('');
  });

  it('handles a template with no variables', () => {
    expect(substituteKeys('No variables here', subs({ name: 'test' }))).toBe('No variables here');
  });

  it('leaves malformed syntax alone', () => {
    expect(substituteKeys('{{incomplete', subs({ incomplete: 'test' }))).toBe('{{incomplete');
  });

  // from template-substitution.test.ts
  it('substitutes basic variables', () => {
    expect(substituteKeys('Hello {{name}}!', subs({ name: 'Coach Artie' }))).toBe('Hello Coach Artie!');
  });

  it('substitutes several variables in a sentence', () => {
    expect(
      substituteKeys('User {{user}} wants {{item}}', subs({ user: 'Alice', item: 'coffee' }))
    ).toBe('User Alice wants coffee');
  });

  it('leaves missing variables unchanged mid-sentence', () => {
    expect(
      substituteKeys('Hello {{name}}, you have {{count}} messages', subs({ name: 'Bob' }))
    ).toBe('Hello Bob, you have {{count}} messages');
  });

  it('handles whitespace around a single key', () => {
    expect(substituteKeys('Result: {{ result }}', subs({ result: 'success' }))).toBe('Result: success');
  });
});

// ---------------------------------------------------------------------------------------------
// GlobalVariableStore.substitute: the DB-backed {{var}} pass (the in-memory test DB)
// ---------------------------------------------------------------------------------------------

describe('GlobalVariableStore.substitute', () => {
  const store = GlobalVariableStore.getInstance();

  // atomic/template-substitution "should stringify objects": the copy did this for local
  // values; in src only the global store JSON-stringifies (local results go through String()).
  it('stringifies a stored object', async () => {
    await store.set('wave11_data', { key: 'value', count: 42 });
    expect(await store.substitute('Data: {{wave11_data}}')).toBe('Data: {"key":"value","count":42}');
  });

  // template-substitution.test.ts "should handle object values by stringifying them"
  it('stringifies a stored object with a number field', async () => {
    await store.set('wave11_obj', { key: 'value', number: 42 });
    expect(await store.substitute('Data: {{wave11_obj}}')).toBe('Data: {"key":"value","number":42}');
  });
});

// ---------------------------------------------------------------------------------------------
// substituteTemplateVariables: previous results -> {{result}}, {{content}}, {{result_N}}, {{memories}}
// ---------------------------------------------------------------------------------------------

function cap(content: string, params: Record<string, unknown> = {}): ExtractedCapability {
  return { name: 'web', action: 'search', params, content, priority: 0 };
}
function res(name: string, data: unknown, success = true): CapabilityResult {
  return {
    capability: { name, action: 'x', params: {}, priority: 0 },
    success,
    data,
    timestamp: '2026-10-23T00:00:00Z',
  };
}
const fill = async (content: string, results: CapabilityResult[]) =>
  (await capabilityExecutor.substituteTemplateVariables(cap(content), results)).content;

const ALL_KEYS = 'r={{result}} c={{content}} 1={{result_1}} 2={{result_2}} m={{memories}}';

describe('substituteTemplateVariables', () => {
  // from template-substitution.test.ts
  it('builds the keys from previous results', async () => {
    const out = await fill(ALL_KEYS, [
      res('memory', 'Alice prefers tea'),
      res('web', 'Generated content here'),
    ]);
    expect(out).toBe(
      'r=Generated content here c=Generated content here 1=Alice prefers tea 2=Generated content here m=Alice prefers tea'
    );
  });

  it('handles the LEGO-block chaining pattern', async () => {
    const results = [res('memory', 'User achievements: Led 3 major projects, Expert in TypeScript')];
    expect(await fill('Format as resume: {{memories}}', results)).toBe(
      'Format as resume: User achievements: Led 3 major projects, Expert in TypeScript'
    );

    results.push(res('web', '# Resume\n\n## Experience\n- Led 3 major projects\n- Expert in TypeScript'));
    expect(await fill('{{content}}', results)).toBe(
      '# Resume\n\n## Experience\n- Led 3 major projects\n- Expert in TypeScript'
    );
  });

  it('leaves {{result}} alone with no previous results', async () => {
    expect(await fill('Hello {{result}}', [])).toBe('Hello {{result}}');
  });

  it('handles several keys in one template', async () => {
    const out = await fill('Previous: {{result_1}}, Current: {{result}}, Memory: {{memories}}', [
      res('memory', 'chocolate preferences'),
      res('variable', 'stored_value'),
      res('web', 'final output'),
    ]);
    expect(out).toBe('Previous: chocolate preferences, Current: final output, Memory: chocolate preferences');
  });

  it('substitutes string params too, without mutating the original', async () => {
    const original = cap('', { query: 'about {{result}}', limit: 3 });
    const out = await capabilityExecutor.substituteTemplateVariables(original, [res('web', 'cats')]);
    expect(out.params).toEqual({ query: 'about cats', limit: 3 });
    expect(original.params.query).toBe('about {{result}}');
  });
});

// Was atomic/variable-context-builder.test.ts: a VariableContextBuilder class that existed only
// in the test. These pin the real map substituteTemplateVariables builds.
describe('substituteTemplateVariables: the {{result}} keys', () => {
  it('no results: every key stays as written', async () => {
    expect(await fill(ALL_KEYS, [])).toBe(ALL_KEYS);
  });

  it('a single memory result fills result, content, result_1 and memories', async () => {
    expect(await fill(ALL_KEYS, [res('memory', 'test data')])).toBe(
      'r=test data c=test data 1=test data 2={{result_2}} m=test data'
    );
  });

  it('several results: result/content are the latest; there is no {{web_content}}', async () => {
    // copy said a web result also sets {{web_content}}; src has no such key.
    const out = await fill(ALL_KEYS + ' w={{web_content}}', [
      res('memory', 'memory data'),
      res('web', 'web data'),
    ]);
    expect(out).toBe('r=web data c=web data 1=memory data 2=web data m=memory data w={{web_content}}');
  });

  it('failed results are NOT skipped', async () => {
    // copy said failed results are skipped; src indexes every previous result.
    const out = await fill(ALL_KEYS + ' 3={{result_3}}', [
      res('memory', 'good data'),
      res('web', 'bad data', false),
      res('filesystem', 'final data'),
    ]);
    expect(out).toBe('r=final data c=final data 1=good data 2=bad data m=good data 3=final data');
  });

  it('memories is the latest memory result', async () => {
    const out = await fill('{{memories}} {{result_1}} {{result_2}}', [
      res('memory', 'first memory'),
      res('memory', 'second memory'),
    ]);
    expect(out).toBe('second memory first memory second memory');
  });

  it('object data goes through String(), and empty data becomes ""', async () => {
    // copy said objects are kept/JSON'd; src does String(data || '').
    const out = await fill('[{{result_1}}] [{{result}}]', [
      res('memory', { user: 'test', preferences: ['dark_mode'] }),
      res('web', null),
    ]);
    expect(out).toBe('[[object Object]] []');
  });
});

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

  it('a short prefix finds create_directory (registry and parser suggesters)', () => {
    expect(registry.generateActionError('filesystem', 'cre')).toContain('create_directory');
    expect(capabilityParser.findSimilarActions('cre', FS_ACTIONS)).toContain('create_directory');
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

/**
 * Wave 8: the native tool list, built from the REAL registry (booted like roster.test.ts).
 *
 * capability-to-tool.ts (1461974, now tool-schema.ts) shipped without a test file; this is new.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry, TOOL_ALIASES } from '../../src/engine/5-tool-loop/registry.js';
import {
  registryToTools,
  capabilityToTool,
  toolCallToInvocation,
  toToolName,
  type ToolDefinition,
} from '../../src/engine/5-tool-loop/tool-schema.js';
import { declaredToolContent, declaresParams, declaredToolParams } from '../../src/engine/5-tool-loop/tool-policy.js';
import { toCallNotation, stripXmlToolTeaching } from '../../src/engine/5-tool-loop/mode.js';

async function bootRegistry(): Promise<void> {
  capabilityBootstrap.initializeCapabilityRegistry();
  const deadline = Date.now() + 5000;
  while (!capabilityRegistry.has('skills') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('registryToTools over the real registry', () => {
  let tools: ToolDefinition[];

  beforeAll(async () => {
    await bootRegistry();
    tools = registryToTools(capabilityRegistry.list());
    // For the BUILD-LOG: how big the tool list is on the wire.
    const biggest = tools
      .map((t) => [t.function.name, JSON.stringify(t).length] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([n, b]) => `${n}:${b}`)
      .join(' ');
    console.log(
      `NATIVE_TOOLS count=${tools.length} bytes=${JSON.stringify(tools).length} biggest=${biggest}`
    );
  }, 20000);

  it('every tool name matches ^[a-zA-Z0-9_-]{1,64}$ and is the registry name unchanged', () => {
    expect(tools.length).toBeGreaterThan(10);
    for (const cap of capabilityRegistry.list()) {
      expect(toToolName(cap.name), cap.name).toBe(cap.name);
    }
    for (const tool of tools) {
      expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('the action enum equals each capability supportedActions', () => {
    for (const tool of tools) {
      const cap = capabilityRegistry.list().find((c) => c.name === tool.function.name)!;
      const action = tool.function.parameters.properties.action as { enum: string[] } | undefined;
      if (cap.supportedActions.length === 0) {
        expect(action).toBeUndefined();
      } else {
        expect(action!.enum).toEqual(cap.supportedActions);
        expect(tool.function.parameters.required).toContain('action');
      }
    }
  });

  it('lists canonical names only: no alias, no variable', () => {
    const names = tools.map((t) => t.function.name);
    for (const alias of Object.keys(TOOL_ALIASES)) {
      expect(names).not.toContain(alias);
    }
    expect(names).not.toContain('variable');
    expect(capabilityRegistry.has('variable')).toBe(true); // still executable on the XML path
    expect(names.length).toBe(capabilityRegistry.list().length - 1);
  });

  it('is sorted by name and byte-identical across two builds', () => {
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual([...names].sort());
    const again = registryToTools([...capabilityRegistry.list()].reverse());
    expect(JSON.stringify(again)).toBe(JSON.stringify(tools));
  });

  it('params are strings unless a tool declares a type (handlers still receive strings)', () => {
    const declaredTypes = new Map<string, string>();
    for (const cap of capabilityRegistry.list()) {
      for (const spec of Object.values(cap.actions ?? {})) {
        for (const [name, param] of Object.entries(spec.params ?? {})) {
          declaredTypes.set(`${toToolName(cap.name)}.${name}`, param.type);
        }
      }
    }
    for (const tool of tools) {
      for (const [key, schema] of Object.entries(tool.function.parameters.properties)) {
        const id = `${tool.function.name}.${key}`;
        expect((schema as { type: string }).type, id).toBe(declaredTypes.get(id) ?? 'string');
      }
    }
    // toolCallToInvocation stringifies typed values, so a handler written for the XML path
    // still sees "30", not 30.
    expect(toolCallToInvocation('meeting-scheduler', { action: 'create', duration: 30 }).params)
      .toEqual({ duration: '30' });
  });

  it('declared params replace the data= blob: discord-forums shows only its declared params', () => {
    const forums = tools.find((t) => t.function.name === 'discord-forums')!;
    const props = Object.keys(forums.function.parameters.properties).sort();
    // No free-text `content`: no forums action reads it (create-post takes `message`).
    expect(props).toEqual(['action', 'forumId', 'message', 'repo', 'tag', 'threadId', 'title']);
    expect(forums.function.parameters.required).toEqual(['action']);
  });

  it('discord-channels offers channelId (Artie, 2026-11-23: "the tool definition doesn\'t list channelId")', () => {
    const channels = tools.find((t) => t.function.name === 'discord-channels')!;
    expect(Object.keys(channels.function.parameters.properties)).toEqual(
      expect.arrayContaining(['action', 'channelId', 'limit', 'before', 'after'])
    );
    // The other body tools' targets are visible too; the server never is.
    const props = (name: string) => Object.keys(tools.find((t) => t.function.name === name)!.function.parameters.properties);
    expect(props('discord-send-message')).toEqual(expect.arrayContaining(['channelId', 'messageId']));
    expect(props('discord-send-message')).not.toContain('guildId');
    expect(props('discord-threads')).toEqual(expect.arrayContaining(['channelId', 'messageId']));
    expect(props('discord-user-history')).toEqual(expect.arrayContaining(['userId']));
  });

  it('only these tools let the model pick a channel, message or person id (pinned)', () => {
    // A new tool declaring one of these must be a deliberate edit here: its id becomes
    // model-written, so its handler must take trust from CapabilityContext, not params.
    const TARGETS = new Set(['channelId', 'messageId', 'userId']);
    const exposing = capabilityRegistry
      .list()
      .filter((cap) => declaredToolParams(cap.actions).some(([param]) => TARGETS.has(param)))
      .map((cap) => cap.name)
      .sort();
    // discord-poll joined 2026-11-24: its channelId is checked against this server (and Room 302
    // or EJ for another channel) in poll.ts pollTarget; read/end go through the gateway's guild check.
    // discord-reaction joined 2026-11-24: read's channelId must pass audienceReadable (reaction.ts readTarget).
    expect(exposing).toEqual([
      'discord-channels',
      'discord-poll',
      'discord-reaction',
      'discord-send-message',
      'discord-threads',
      'discord-user-history',
    ]);
  });

  it('content is offered only where a declared action reads it', () => {
    const byName = (name: string) => tools.find((t) => t.function.name === name)!;
    const memory = byName('memory').function.parameters.properties;
    expect(memory.content).toBeDefined();
    expect((memory.content as { description: string }).description).toContain('for remember');
    expect(byName('discord-forums').function.parameters.properties.content).toBeUndefined();
    expect(byName('meeting-scheduler').function.parameters.properties.content).toBeUndefined();
    // Undeclared-param tools keep the generic field.
    expect(byName('calculator').function.parameters.properties.content).toBeDefined();
    // Every tool that declares params and offers content has an action that says so.
    for (const cap of capabilityRegistry.list()) {
      const tool = byName(cap.name);
      if (!tool || !declaresParams(cap.actions)) continue;
      const declared = declaredToolContent(cap.actions) !== undefined;
      expect(tool.function.parameters.properties.content !== undefined, cap.name).toBe(declared);
    }
  });

  // Guard (2026-11-17): content is opt-in once a tool declares params, so adding params to a
  // tool whose handler reads `content` would silently drop the field the model fills. These
  // tools read it (audited when the opt-in landed); each must keep offering it. If one stops
  // reading content, remove it here on purpose.
  it('tools whose handlers read content keep offering it', () => {
    const CONTENT_READERS = [
      'hermes', 'email', 'stripe', 'mediawiki', 'approvals', 'reddit', 'deep_research', 'http',
      'discord-ui', 'github', 'memory', 'scratchpad', 'system_memory',
    ];
    for (const name of CONTENT_READERS) {
      const tool = tools.find((t) => t.function.name === name);
      expect(tool, `${name} not registered`).toBeDefined();
      expect(tool!.function.parameters.properties.content, name).toBeDefined();
    }
  });

  it('the overlapping-tool use-when sentence lands inside the clipped first line', () => {
    for (const name of ['memory', 'scratchpad', 'system_memory', 'relay', 'proactive-dm']) {
      const desc = tools.find((t) => t.function.name === name)!.function.description;
      expect(desc.length, name).toBeGreaterThan(0);
    }
    const desc = (name: string) => tools.find((t) => t.function.name === name)!.function.description;
    expect(desc('relay')).toContain('scheduler');
    expect(desc('proactive-dm')).toContain('scheduler');
    expect(desc('proactive-dm')).toContain('relay');
    expect(desc('scratchpad')).toContain('memory');
    expect(desc('system_memory')).toContain('memory');
    expect(desc('memory')).toContain('scope');
  });

  it('teaches no XML: descriptions carry no <capability> tags', () => {
    for (const tool of tools) {
      expect(tool.function.description, tool.function.name).not.toContain('<capability');
    }
  });

  it('moderation keeps its timeout-by-name params (user, durationMinutes, reason)', () => {
    const mod = tools.find((t) => t.function.name === 'discord-moderation');
    expect(mod).toBeDefined();
    const props = mod!.function.parameters.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['user', 'durationMinutes', 'reason']));
    expect((props.action as { enum: string[] }).enum).toContain('timeout');
  });

  it('the scheduler tool is offered (reminders)', () => {
    expect(tools.map((t) => t.function.name)).toContain('scheduler');
  });
});

describe('capabilityToTool / toolCallToInvocation', () => {
  it('channelId/guildId are declared but never required (filled from the conversation)', () => {
    const tool = capabilityToTool({
      name: 'send-message',
      supportedActions: ['send'],
      requiredParams: ['guildId', 'channelId', 'message'],
      handler: async () => 'ok',
    });
    expect(tool.function.parameters.required).toEqual(['action', 'message']);
    expect(Object.keys(tool.function.parameters.properties)).toEqual(
      expect.arrayContaining(['guildId', 'channelId', 'message', 'content'])
    );
  });

  it('content follows the declaration: omitted, described, or generic', () => {
    const base = { name: 't', supportedActions: ['a', 'b'], handler: async () => 'ok' };
    const noContent = capabilityToTool({
      ...base,
      actions: {
        a: { effect: 'read', params: { q: { type: 'string', description: 'query' } } },
        b: { effect: 'read' },
      },
    });
    expect(noContent.function.parameters.properties.content).toBeUndefined();

    const withContent = capabilityToTool({
      ...base,
      actions: {
        a: { effect: 'own', content: 'The note', params: { q: { type: 'string', description: 'query' } } },
        b: { effect: 'read' },
      },
    });
    expect(withContent.function.parameters.properties.content).toEqual({
      type: 'string',
      description: 'The note (for a)',
    });

    // Declared actions but no params at all: handlers were never audited, keep the generic field.
    const noParams = capabilityToTool({
      ...base,
      actions: { a: { effect: 'read' }, b: { effect: 'read' } },
    });
    expect(noParams.function.parameters.properties.content).toBeDefined();
  });

  it('splits action and content out, and stringifies non-string args', () => {
    expect(
      toolCallToInvocation('discord-moderation', {
        action: 'timeout',
        user: 'YellowAquarium',
        durationMinutes: 5,
        content: 'body',
        extra: null,
      })
    ).toEqual({
      name: 'discord-moderation',
      action: 'timeout',
      content: 'body',
      params: { user: 'YellowAquarium', durationMinutes: '5' },
    });
  });
});

describe('call notation (XML examples rewritten for native mode)', () => {
  it('rewrites self-closing and paired tags', () => {
    expect(toCallNotation('Use: <capability name="web" action="search" query="x" />')).toBe(
      'Use: web(action="search", query="x")'
    );
    expect(
      toCallNotation('<capability name="memory" action="remember" importance="8">a fact</capability>')
    ).toBe('memory(action="remember", importance="8", content="a fact")');
    expect(
      toCallNotation(
        `<capability name="discord-ui" action="buttons" data='[{"label":"A"}]' /> then <capability name="tts" action="sing">la</capability>`
      )
    ).toBe('discord-ui(action="buttons", data="[{\\"label\\":\\"A\\"}]") then tts(action="sing", content="la")');
  });

  it('keeps a quoted ">" inside an attribute value (Discord mentions)', () => {
    expect(
      toCallNotation('<capability name="meeting-scheduler" action="suggest-time" participants="<@123456>,bob" />')
    ).toBe('meeting-scheduler(action="suggest-time", participants="<@123456>,bob")');
  });

  it('stripXmlToolTeaching drops the roster and wants_loop lines, and is a no-op without markers', () => {
    const plain = 'you are artie.\n\n\nno markers here';
    expect(stripXmlToolTeaching(plain)).toBe(plain);
    const out = stripXmlToolTeaching(
      'persona\n## Your capability roster\n- web [search]: x\n- tts [sing]: y\n## Next\nkeep\nAdd <wants_loop>true</wants_loop>\nUse: <capability name="web" action="search" query="q" />'
    );
    expect(out).toBe('persona\n## Next\nkeep\nUse: web(action="search", query="q")');
  });
});

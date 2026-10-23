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
    // eslint-disable-next-line no-console
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

  it('every param is a string (the XML path only ever passed strings)', () => {
    for (const tool of tools) {
      for (const [key, schema] of Object.entries(tool.function.parameters.properties)) {
        expect((schema as { type: string }).type, `${tool.function.name}.${key}`).toBe('string');
      }
    }
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

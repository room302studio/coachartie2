/**
 * Wave 6: one capability roster per prompt.
 *
 * Before wave 6 a first turn carried the roster twice inside the cached system message:
 * system-prompt.ts appended buildCapabilityRoster to PROMPT_SYSTEM, and context assembly
 * pushed the registry's compressed listing ("SIMPLE SHORTCUTS ... Available: name(a|b),
 * ...") as a priority-96 'capability_context' source that assembleMessageChain appended to
 * the same message. This builds a first turn the way generate-reply does (DB prompt →
 * getCapabilityInstructions → buildMessageChain, full mode, Discord source) and checks
 * every registered capability is listed exactly once, in the roster's format only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import { promptManager } from '../../src/engine/3-context/system-prompt.js';
import { contextAlchemy } from '../../src/engine/3-context/assemble.js';
import { getSyncDb } from '../../src/shared/db/client.js';

const PERSONA = '<role>\nyou are coach artie (test persona).\n</role>';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// The roster is XML-path prompt content: since wave 8 it is built only under TOOL_LOOP=xml.
// XML-LOOP: delete after v3 soak (TOOL_LOOP=xml) — the first describe; keep the native one.
const savedToolLoop = process.env.TOOL_LOOP;

describe('capability roster appears once per prompt (TOOL_LOOP=xml)', () => {
  beforeAll(async () => {
    process.env.TOOL_LOOP = 'xml';
    capabilityBootstrap.initializeCapabilityRegistry();
    // Skills register in a setImmediate after bootstrap (see roster.test.ts). Let them land
    // first, so the roster and the registry list are read from the same set.
    const deadline = Date.now() + 5000;
    while (!capabilityRegistry.has('skills') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The production path: PROMPT_SYSTEM exists, so getCapabilityInstructions appends the
    // roster to it. The in-memory test DB has the prompts table but no rows.
    getSyncDb().run(
      `INSERT OR REPLACE INTO prompts (name, content, category, is_active) VALUES (?, ?, ?, 1)`,
      ['PROMPT_SYSTEM', PERSONA, 'system']
    );
  });

  afterAll(() => {
    getSyncDb().run(`DELETE FROM prompts WHERE name = ?`, ['PROMPT_SYSTEM']);
    if (savedToolLoop === undefined) delete process.env.TOOL_LOOP;
    else process.env.TOOL_LOOP = savedToolLoop;
  });

  it('an assembled first-turn chain lists each capability exactly once', async () => {
    const base = await promptManager.getCapabilityInstructions('hey artie, what can you do?');
    expect(base.startsWith(PERSONA)).toBe(true);

    const { messages } = await contextAlchemy.buildMessageChain(
      'hey artie, what can you do?',
      'user-roster-test',
      base,
      [],
      {
        source: 'discord',
        channelId: 'channel-roster-test',
        // Keep the test off the memory/rules paths; neither touches the roster.
        enableMemories: false,
        enableRules: false,
      }
    );

    const all = messages.map((m) => m.content).join('\n\n');
    const names = capabilityRegistry.list().map((c) => c.name);
    expect(names.length).toBeGreaterThan(10);

    // One roster header, in the cached first system message.
    expect(countOccurrences(all, '## Your capability roster')).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('## Your capability roster');

    // Each capability is listed once, as a roster line.
    for (const name of names) {
      expect(countOccurrences(all, `\n- ${name} [`), name).toBe(1);
    }

    // The removed compressed listing is gone.
    // Its two fingerprints: the shortcuts header, and the "name(a|b), name(c|d)" list shape.
    expect(all).not.toContain('SIMPLE SHORTCUTS (preferred)');
    expect(all).not.toMatch(/\b[\w-]+\([\w|-]+\), [\w-]+\([\w|-]+\)/);
  }, 20000);
});

describe('native tools (TOOL_LOOP unset): no roster, no XML teaching, one tools line', () => {
  beforeAll(() => {
    delete process.env.TOOL_LOOP;
    getSyncDb().run(
      `INSERT OR REPLACE INTO prompts (name, content, category, is_active) VALUES (?, ?, ?, 1)`,
      ['PROMPT_SYSTEM', PERSONA, 'system']
    );
    // A DB prompt that still teaches the XML format (the live PROMPT_DISCORD_UI_MODALITY shape).
    getSyncDb().run(
      `INSERT OR REPLACE INTO prompts (name, content, category, is_active) VALUES (?, ?, ?, 1)`,
      [
        'PROMPT_DISCORD_UI_MODALITY',
        'CHOICE → USE BUTTONS:\nUse: <capability name="discord-ui" action="buttons" data=\'[{"label":"A"}]\' />\nAdd <wants_loop>true</wants_loop> for long tasks',
        'system',
      ]
    );
  });

  afterAll(() => {
    getSyncDb().run(`DELETE FROM prompts WHERE name IN (?, ?)`, [
      'PROMPT_SYSTEM',
      'PROMPT_DISCORD_UI_MODALITY',
    ]);
    if (savedToolLoop === undefined) delete process.env.TOOL_LOOP;
    else process.env.TOOL_LOOP = savedToolLoop;
  });

  it('the cached system message has the persona, call notation, and the native line once', async () => {
    const base = await promptManager.getCapabilityInstructions('hey artie, what can you do?');
    expect(base).toBe(PERSONA);

    const build = async () =>
      (
        await contextAlchemy.buildMessageChain('hey artie, what can you do?', 'user-native-test', base, [], {
          source: 'discord',
          channelId: 'channel-native-test',
          enableMemories: false,
          enableRules: false,
        })
      ).messages;
    const messages = await build();
    const system = messages[0].content;

    expect(system.startsWith(PERSONA)).toBe(true);
    expect(system).not.toContain('## Your capability roster');
    expect(system).not.toContain('<capability '); // a tag; the native line names "<capability>" itself
    expect(system).not.toContain('wants_loop');
    expect(system).toContain('Use: discord-ui(action="buttons", data="[{\\"label\\":\\"A\\"}]")');
    expect(countOccurrences(system, 'Use the provided tools; never write <capability> tags.')).toBe(1);
    expect(system.endsWith('Use the provided tools; never write <capability> tags.')).toBe(true);

    // Byte-stable across builds (it is the cached prefix).
    expect((await build())[0].content).toBe(system);
  }, 20000);
});

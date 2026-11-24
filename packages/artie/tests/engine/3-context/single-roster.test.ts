/**
 * Native tools: no roster in the prompt, no XML teaching, one tools line.
 *
 * Builds a first turn the way generate-reply does (DB prompt → getCapabilityInstructions →
 * buildMessageChain, full mode, Discord source) and checks the cached system message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promptStore } from '../../../src/engine/3-context/prompt-store.js';
import { contextAssembler } from '../../../src/engine/3-context/assemble.js';
import { getSyncDb } from '../../../src/shared/db/client.js';

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

describe('native tools: no roster, no XML teaching, one tools line', () => {
  beforeAll(() => {
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
  });

  it('the cached system message has the persona, call notation, and the native line once', async () => {
    const base = await promptStore.getCapabilityInstructions('hey artie, what can you do?');
    expect(base).toBe(PERSONA);

    const build = async () =>
      (
        await contextAssembler.buildMessageChain('hey artie, what can you do?', 'user-native-test', base, [], {
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

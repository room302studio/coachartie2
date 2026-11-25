/**
 * 2026-11-17: every DM user used to share one 'default' pad, and a model-supplied guildId could
 * open another server's pad from any conversation.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  findHeadingLine,
  getGuildNotesPath,
  scratchpadKey,
} from '../../../../src/engine/capabilities/planning/scratchpad.js';
import { getGuildConfig } from '../../../../src/shared/config/guilds.js';
import { GUILD_NOTES_DIR, getGuildDocsRoot } from '../../../../src/shared/paths.js';

// 2026-11-24: the tool wrote one file and the gateway put a different one in context, so notes
// Artie saved never reached him. The pad IS the guild's scratchpadPath now.
describe('getGuildNotesPath', () => {
  it("a configured guild's pad is the file the gateway reads into its context", () => {
    const room302 = getGuildConfig('932719842522443928');
    expect(room302?.scratchpadPath).toBeTruthy();
    expect(getGuildNotesPath('932719842522443928')).toBe(
      join(getGuildDocsRoot(), room302?.scratchpadPath ?? '')
    );
  });

  it('a section heading matches whole lines only', () => {
    const pad = '# Notes\n## Community Members\n- a\n## Community\n- b';
    expect(findHeadingLine(pad, '## Community')).toBe(pad.indexOf('## Community\n'));
    expect(findHeadingLine(pad, '## Recurring')).toBe(-1);
  });

  it('DM, default and unconfigured pads live in GUILD_NOTES_DIR', () => {
    expect(getGuildNotesPath('dm-u1')).toBe(join(GUILD_NOTES_DIR, 'guild-dm-u1.md'));
    expect(getGuildNotesPath('default')).toBe(join(GUILD_NOTES_DIR, 'guild-default.md'));
  });
});

describe('scratchpadKey', () => {
  it("a server conversation uses that server's pad, never a model-supplied one", () => {
    expect(scratchpadKey({ guildId: 'g302', userId: 'u1' }, 'g-other')).toBe('g302');
  });

  it('each DM user gets their own pad', () => {
    expect(scratchpadKey({ userId: 'u1' }, undefined)).toBe('dm-u1');
    expect(scratchpadKey({ userId: 'u2' }, 'g302')).toBe('dm-u2');
  });

  it('only context-less internal callers may name a guild, and only a safe one', () => {
    expect(scratchpadKey(undefined, 'g302')).toBe('g302');
    expect(scratchpadKey(undefined, '../../etc')).toBe('default');
    expect(scratchpadKey(undefined, undefined)).toBe('default');
  });

  it('a DM user id cannot escape the notes directory', () => {
    expect(scratchpadKey({ userId: '../../x' }, undefined)).toBe('dm-x');
  });
});

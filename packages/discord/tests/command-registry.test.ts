import { describe, it, expect } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { globalCommands } from '../src/commands/registry.js';

const byName = new Map(globalCommands.map((c) => [c.data.name, c.data.toJSON()]));

describe('global command registry', () => {
  it('has unique names and a handler for each', () => {
    expect(byName.size).toBe(globalCommands.length);
    for (const c of globalCommands) expect(typeof c.execute).toBe('function');
  });

  it('includes the commands that used to be missing from Discord', () => {
    for (const name of ['quiz', 'watch-repo', 'unwatch-repo', 'list-watches', 'pairing']) {
      expect(byName.has(name)).toBe(true);
    }
    for (const dead of ['link-phone', 'verify-phone', 'unlink-phone']) {
      expect(byName.has(dead)).toBe(false);
    }
  });

  it('gates the commands that change things', () => {
    const perm = (name: string) => byName.get(name)?.default_member_permissions;
    expect(perm('watch-repo')).toBe(PermissionFlagsBits.ManageChannels.toString());
    expect(perm('unwatch-repo')).toBe(PermissionFlagsBits.ManageChannels.toString());
    expect(perm('sync-discussions')).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(perm('pairing')).toBe(PermissionFlagsBits.Administrator.toString());
  });

  it('wires autocomplete for the repo pickers', () => {
    for (const name of ['watch-repo', 'unwatch-repo']) {
      const c = globalCommands.find((x) => x.data.name === name)!;
      expect(typeof c.autocomplete).toBe('function');
    }
  });
});

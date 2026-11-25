/**
 * Trust boundaries are pinned (shared/trusted-ids.ts). A file that mints trusted ids is a place
 * where we decided an id genuinely came from Discord, EJ or our own engine. Adding one is fine,
 * but it must be a deliberate edit here, never a quiet `mintTrusted(params...)` in a tool.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { mintTrusted, mintTrustedGuild } from '../../src/shared/trusted-ids.js';

const SRC = join(__dirname, '../../src');

/** file -> the sources it may mint with. */
const MINT_SITES: Record<string, string[]> = {
  'engine/capabilities/run-with-retry.ts': ['discord-turn'],
  'engine/2-turn/run-turn.ts': ['discord-turn'],
  'engine/capabilities/people/email-drafting.ts': ['discord-turn'],
  'engine/jobs/scheduler.ts': ['engine-job'],
  'engine/jobs/scribe/orchestrator.ts': ['engine-job'],
  'engine/capabilities/ops/approvals.ts': ['approval-replay'],
  'engine/routes/capability-registry.ts': ['local-api'],
  // EJ in his own DM naming a server; both files check isOwner and !context.guildId first.
  'engine/capabilities/discord/forums.ts': ['owner-dm-choice'],
  'engine/capabilities/discord/send-message.ts': ['owner-dm-choice'],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('trusted ids', () => {
  it('only the pinned files mint, each with only its pinned sources', () => {
    const found: Record<string, string[]> = {};
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel === 'shared/trusted-ids.ts') {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      // A real call has an argument; `mintTrusted()` in a doc comment is not a mint site.
      if (!/mintTrusted(Guild)?\((?!\))/.test(text)) {
        continue;
      }
      const sources = [...text.matchAll(/'(discord-turn|approval-replay|local-api|engine-job|owner-dm-choice)'\s*\)/g)].map((m) => m[1]);
      found[rel] = [...new Set(sources)].sort();
    }
    const pinned = Object.fromEntries(Object.entries(MINT_SITES).map(([k, v]) => [k, [...v].sort()]));
    expect(found).toEqual(pinned);
  });

  it('mints only real ids and drops the rest', () => {
    expect(mintTrusted({ guildId: '932719842522443928', channelId: '', userId: undefined }, 'discord-turn')).toEqual({
      guildId: '932719842522443928',
    });
    expect(mintTrustedGuild({ evil: true }, 'owner-dm-choice')).toBeUndefined();
    expect(mintTrustedGuild(123, 'owner-dm-choice')).toBe('123');
  });
});

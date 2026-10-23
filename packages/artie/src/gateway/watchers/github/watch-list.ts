import {
  getDb,
  githubRepoWatches,
  type GithubRepoWatch,
  eq,
  and,
} from '@coachartie/shared';

/**
 * GitHub watch management for the slash commands (watch-repo / unwatch-repo / list-watches).
 *
 * Talks to the DB directly: the commands used to go through the poller instance and, when it
 * wasn't initialized, swallowed the error and reported success anyway.
 *
 * Unwatching PAUSES a watch (is_active = 0) instead of deleting it. The org watcher re-adds any
 * room302studio repo that has no row at all, so a deleted watch quietly came back on its next
 * sync; a paused row stays paused. Watches are per repo per guild, whatever channel you run
 * the command from.
 */

/** Event names the poller understands (github-poller.ts pollRepo). */
export const WATCH_EVENTS = ['all', 'pr', 'review', 'issues', 'push', 'ci'] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];

export const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/** Parse "pr, ci" / "all" into a validated event list; returns the invalid names too. */
export function parseWatchEvents(raw: string | null | undefined): {
  events: WatchEvent[];
  invalid: string[];
} {
  const names = (raw || 'all')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const invalid = names.filter((e) => !(WATCH_EVENTS as readonly string[]).includes(e));
  const valid = [...new Set(names.filter((e): e is WatchEvent => !invalid.includes(e)))];
  return { events: valid.includes('all') || valid.length === 0 ? ['all'] : valid, invalid };
}

export function describeEvents(eventsJson: string | null | undefined): string {
  let events: string[] = ['all'];
  try {
    events = eventsJson ? JSON.parse(eventsJson) : ['all'];
  } catch {
    // leave as all
  }
  return events.includes('all') ? 'everything' : events.join(', ');
}

function watchesFor(repo: string, guildId: string): GithubRepoWatch[] {
  return getDb()
    .select()
    .from(githubRepoWatches)
    .where(and(eq(githubRepoWatches.repo, repo), eq(githubRepoWatches.guildId, guildId)))
    .all();
}

export type WatchOutcome = 'created' | 'updated' | 'resumed';

/**
 * Watch a repo in a channel, or change an existing watch in this guild: move it to this
 * channel, set its events, and resume it if paused.
 */
export function upsertWatch(
  repo: string,
  guildId: string,
  channelId: string,
  events: WatchEvent[],
  createdBy: string
): { outcome: WatchOutcome; previousChannelId?: string } {
  const now = new Date().toISOString();
  const [existing] = watchesFor(repo, guildId);
  if (!existing) {
    getDb()
      .insert(githubRepoWatches)
      .values({
        repo,
        guildId,
        channelId,
        events: JSON.stringify(events),
        isActive: true,
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { outcome: 'created' };
  }
  getDb()
    .update(githubRepoWatches)
    .set({ channelId, events: JSON.stringify(events), isActive: true, updatedAt: now })
    .where(and(eq(githubRepoWatches.repo, repo), eq(githubRepoWatches.guildId, guildId)))
    .run();
  return {
    outcome: existing.isActive ? 'updated' : 'resumed',
    previousChannelId: existing.channelId !== channelId ? existing.channelId : undefined,
  };
}

/** Pause every watch of this repo in this guild. Returns how many were active. */
export function pauseWatch(repo: string, guildId: string): { paused: number; found: number } {
  const rows = watchesFor(repo, guildId);
  const active = rows.filter((w) => w.isActive).length;
  if (active > 0) {
    getDb()
      .update(githubRepoWatches)
      .set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(and(eq(githubRepoWatches.repo, repo), eq(githubRepoWatches.guildId, guildId)))
      .run();
  }
  return { paused: active, found: rows.length };
}

export function listGuildWatches(guildId: string, channelId?: string): GithubRepoWatch[] {
  const rows = getDb()
    .select()
    .from(githubRepoWatches)
    .where(eq(githubRepoWatches.guildId, guildId))
    .all();
  return (channelId ? rows.filter((w) => w.channelId === channelId) : rows).sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.repo.localeCompare(b.repo)
  );
}

/** Repo names in this guild matching what's been typed so far (for autocomplete). */
export function suggestRepos(guildId: string, typed: string, limit = 25): string[] {
  const needle = typed.toLowerCase();
  return [...new Set(listGuildWatches(guildId).map((w) => w.repo))]
    .filter((r) => r.toLowerCase().includes(needle))
    .slice(0, limit);
}

/**
 * Well-known Discord channel configuration.
 *
 * These IDs were previously hardcoded in three separate files. When the old
 * #subwaybuilder-robot channel was deleted, GitHub events kept getting posted at a
 * dead id (Unknown Channel / 10003) and nobody noticed — and the studio feed was
 * pointed at a channel the bot couldn't even see (Missing Access / 50001). One
 * definition + an env override means a channel move is a config change, not a hunt
 * through the codebase.
 */

/**
 * Where GitHub activity (org watcher + webhooks) gets posted: #🤖robot in Room 302.
 * Verified reachable by the bot — a channel it can't post to fails silently.
 */
export const GITHUB_FEED_CHANNEL_ID =
  process.env.GITHUB_FEED_CHANNEL_ID || '1086329744762622023';

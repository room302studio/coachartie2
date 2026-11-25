/**
 * Discord user mentions in raw message text (wave 10, ledger Top-5 #5).
 *
 * `<@id>` and the legacy nickname form `<@!id>` both mean "user id". Where a live Message is
 * at hand discord.js's `cleanContent` resolves mentions too, but it also rewrites the bot's own
 * mention to "@Coach Artie", channels to #name and roles to @role; the sites that use this
 * helper strip or rename specific users only, and the engine's prompt depends on that.
 *
 * The blocklist and privacy opt-out keep their own regexes (ledger KEEP): they match names
 * and ids in arbitrary stored text, not just mention tokens.
 */

/**
 * True when `text` @-mentions `userId` itself (`<@id>` / `<@!id>`). Role mentions (`<@&id>`),
 * @everyone and reply pings don't count, and they don't cancel a real mention next to them:
 * "<@&mods> <@artie> help" addresses Artie (until 2026-11-24 any role mention vetoed it).
 */
export function mentionsUser(text: string, userId: string | undefined | null): boolean {
  if (!userId || !/^\d+$/.test(userId)) return false;
  return new RegExp(`<@!?${userId}>`).test(text);
}

/** Replace every `<@id>` / `<@!id>` mention of `userId` with `replacement`. Non-ids are left alone. */
export function replaceMention(text: string, userId: string | undefined | null, replacement: string): string {
  if (!userId || !/^\d+$/.test(userId)) return text;
  return text.replace(new RegExp(`<@!?${userId}>`, 'g'), () => replacement);
}

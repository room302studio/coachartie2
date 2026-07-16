/**
 * OUTBOUND GATE — the single structural choke point for visible actions.
 *
 * Twice in one week the same bug shipped: an action path (💔 on blocked users,
 * then ambient emoji reactions) ran BEFORE the "coach-artie channels only" check
 * in message-handler.ts, so Artie acted in channels he's banned from speaking in.
 * Both fixes were reorders — which means the third occurrence was inevitable,
 * because the invariant lived in call-site ORDERING instead of code. This module
 * makes it structural: every path that makes Artie visibly act (reply, react,
 * time someone out, proxy-reply) calls checkOutbound() itself, so it no longer
 * matters where in the handler the path sits.
 *
 * RULE: if you're adding a new way for Artie to visibly act in Discord, it MUST
 * consult checkOutbound() first — and if you're about to copy one of these
 * checks inline somewhere, the check belongs HERE instead.
 */

import { Message } from 'discord.js';
import { logger } from '@coachartie/shared';
import { getChannelPersona } from '../config/guild-whitelist.js';

export type OutboundAction = 'reply' | 'reaction' | 'timeout' | 'proxy-reply';

// Subway Builder — the public guild where Artie is only allowed to be visibly
// active in coach-artie places. Other guilds (Room 302 etc.) and DMs are open.
const SUBWAY_BUILDER_GUILD_ID = '1420846272545296470';

// What counts as a coach-artie place: robot-ish channel names, or a channel
// with a configured persona (Judge Artie in #litigation, etc.). This is the
// ONE copy of this regex — do not re-inline it in message-handler.ts.
const COACH_ARTIE_CHANNEL_RE = /🤖|robot|coach.?artie|\bartie\b/i;

// Timeout target protections (mirrors what wardenTimeout enforced inline):
// never bots, never these people, never anyone wearing a staff-shaped role.
const PROTECTED_NAMES = new Set(['jan_gbg', 'hudson', 'colin', 'ejfox']);
const PROTECTED_USER_IDS = new Set(['688448399879438340']); // EJ
const PROTECTED_ROLE_RE = /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/;

// Denials worth a production log line (VPS runs CONSOLE_LOG_LEVEL=warn, so this
// must be warn to be visible). The routine per-message reaction roll loses the
// channel check constantly by design — logging that would be pure noise — but a
// blocked timeout or proxy-reply means something upstream tried to act where it
// shouldn't, and we want to see it.
const LOGGED_DENIALS: ReadonlySet<OutboundAction> = new Set(['timeout', 'proxy-reply']);

function deny(
  action: OutboundAction,
  message: Message,
  reason: string
): { allowed: boolean; reason: string } {
  if (LOGGED_DENIALS.has(action)) {
    logger.warn(`🚧 Outbound gate denied ${action} targeting ${message.author.tag}: ${reason}`);
  }
  return { allowed: false, reason };
}

/**
 * Decide whether Artie may take a visible action in response to this message.
 * Pure permission — rate limits/cooldowns stay at the call sites (they're
 * throttling, not policy).
 */
export function checkOutbound(
  action: OutboundAction,
  message: Message
): { allowed: boolean; reason: string } {
  // CHANNEL INVARIANT: in the public Subway Builder guild, ALL actions —
  // replies AND reactions AND timeouts — require a coach-artie place. No
  // exceptions. DMs and other guilds pass.
  if (message.guildId === SUBWAY_BUILDER_GUILD_ID && !message.channel.isDMBased()) {
    const chName = ('name' in message.channel ? message.channel.name : '') || '';
    const isCoachArtiePlace =
      COACH_ARTIE_CHANNEL_RE.test(chName) || !!getChannelPersona(message.guildId, chName);
    if (!isCoachArtiePlace) {
      return deny(action, message, `#${chName} is not a coach-artie place in Subway Builder`);
    }
  }

  // TARGET INVARIANT (timeouts only): the warden power is Subway Builder only,
  // and never lands on bots, protected users, or staff.
  if (action === 'timeout') {
    if (message.guildId !== SUBWAY_BUILDER_GUILD_ID) {
      return deny(action, message, 'timeouts are Subway Builder only');
    }
    if (message.author.bot) {
      return deny(action, message, 'target is a bot');
    }
    if (!message.member) {
      return deny(action, message, 'no guild member on message');
    }
    const uname = (message.author.username || '').toLowerCase();
    const dname = (message.author.displayName || '').toLowerCase();
    const roles = message.member.roles.cache.map((r) => r.name.toLowerCase());
    if (
      PROTECTED_NAMES.has(uname) ||
      PROTECTED_NAMES.has(dname) ||
      PROTECTED_USER_IDS.has(message.author.id) ||
      roles.some((r) => PROTECTED_ROLE_RE.test(r))
    ) {
      return deny(action, message, `protected user ${message.author.tag}`);
    }
  }

  return { allowed: true, reason: 'ok' };
}

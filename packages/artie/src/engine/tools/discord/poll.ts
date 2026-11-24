/**
 * Discord Poll Capability
 * Lets Artie create native Discord polls in the current channel and read their results.
 * Active polls are rate-limited per channel by the discord service (anti-spam).
 *
 * The params are declared (EJ, 2026-11-24): until then the schema was scraped from the
 * examples, none of which used `multi`, so the model never saw it. Two "pick all that work"
 * scheduling polls went out single-select, and once the model put "allow_multiselect: true"
 * in the free-text body instead. The result now says whether picks are single or multiple, and
 * names any option Discord's limits cut, so Artie can't tell people something the poll isn't.
 */

import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';
import { isOwner } from '../../../shared/config/owner.js';
import { askerOf } from './send-message.js';

/** Discord's limits, mirrored from the gateway route that clamps them. */
const MAX_OPTIONS = 10;
const MAX_OPTION_CHARS = 55;

/** Split "A | B | C" (preferred) or newline-separated option lists into an array. */
export function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((o) => String(o).trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') {
    return [];
  }
  let sep: string;
  if (raw.includes('|')) {
    sep = '|';
  } else {
    sep = '\n';
  }
  return raw
    .split(sep)
    .map((o) => o.trim())
    .filter(Boolean);
}

/** True for a yes in any spelling a model sends: true, "true", "yes", "1". */
export function isYes(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  return ['true', 'yes', '1'].includes(String(value ?? '').trim().toLowerCase());
}

/** What Discord's limits will do to these options: the ones dropped and the ones shortened. */
export function optionLosses(options: string[]): { dropped: string[]; shortened: string[] } {
  return {
    dropped: options.slice(MAX_OPTIONS),
    shortened: options.slice(0, MAX_OPTIONS).filter((o) => o.length > MAX_OPTION_CHARS),
  };
}

function bodyOf(resp: gateway.ApiResult): Record<string, unknown> {
  const body = resp.body;
  if (body && typeof body === 'object') {
    return body as Record<string, unknown>;
  }
  return {};
}

function errorOf(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error === 'string' && body.error) {
    return body.error;
  }
  return fallback;
}

function picksLabel(multi: boolean): string {
  if (multi) {
    return 'multiple choice: people can pick as many as they like';
  }
  return 'single choice: one pick each';
}

type Target = { ok: true; channelId: string } | { ok: false; error: string };

/**
 * Where a poll goes. The conversation channel by default. Another channel only in this server,
 * only in Room 302, and only when EJ asks (Codex: anyone else could have him post into a channel
 * they can't post in themselves). Until 2026-11-24 a model-written channelId was trusted as is,
 * so a poll could land in any channel of any server.
 */
export async function pollTarget(params: Record<string, unknown>, context?: CapabilityContext): Promise<Target> {
  const here = String(context?.channelId || '');
  const asked = String(params.channelId || params.channel_id || '').trim();
  if (!asked || asked === here) {
    if (!here) {
      return { ok: false, error: 'polls only work in a channel' };
    }
    return { ok: true, channelId: here };
  }
  const guildId = context?.guildId;
  if (!guildId) {
    return { ok: false, error: 'a poll in another channel only works inside a server' };
  }
  if (!gateway.guildChannelEntries(guildId).some((e) => e.id === asked)) {
    return { ok: false, error: 'no such channel in this server' };
  }
  if (!(await gateway.mayPostElsewhere(guildId)) || !isOwner(String(context?.userId ?? ''))) {
    return {
      ok: false,
      error: 'I only post polls in the channel we are talking in (EJ can send one elsewhere in Room 302 or the SB2 alpha server)',
    };
  }
  return { ok: true, channelId: asked };
}

/** The poll a read/end call means: the id given, else the last one he made in that channel. */
function pollMessageId(params: Record<string, unknown>, channelId: string): string {
  return String(params.message_id || params.messageId || lastPollByChannel.get(channelId) || '');
}

export async function pollHandler(params: Record<string, unknown>, context?: CapabilityContext): Promise<string> {
  const action = params.action;
  try {
    if (action === 'read_poll' || action === 'end_poll') {
      // The gateway checks the channel is in this server (and, to end one, that it's his poll).
      const channelId = String(params.channelId || params.channel_id || context?.channelId || '');
      const messageId = pollMessageId(params, channelId);
      if (!messageId) {
        return JSON.stringify({ success: false, error: 'no message_id given and no recent poll of yours here' });
      }
      const ref = { channelId, messageId };
      let resp: gateway.ApiResult;
      if (action === 'read_poll') {
        // Another channel only if the person asking can read it, like search (Codex High:
        // otherwise a private channel's poll and voter names leak to whoever asks).
        if (channelId !== String(context?.channelId || '')) {
          const guildId = context?.guildId;
          if (!guildId) {
            return JSON.stringify({ success: false, error: 'reading a poll elsewhere only works inside a server' });
          }
          const scope = await gateway.audienceReadable(guildId, context?.userId ?? null, context?.channelId, channelId);
          if (!scope.ok) {
            return JSON.stringify({ success: false, error: 'that channel is out of reach for this conversation' });
          }
        }
        resp = await gateway.readPollInGuild(context?.guildId ?? null, ref, context?.channelId);
      } else {
        resp = await gateway.endOwnPoll(context?.guildId ?? null, askerOf(context), ref);
      }
      return JSON.stringify(resp.body);
    }

    // create_poll
    const target = await pollTarget(params, context);
    if (!target.ok) {
      return JSON.stringify({ success: false, error: target.error });
    }
    const channelId = target.channelId;
    const question = String(params.question || '').trim();
    const options = parseOptions(params.options);
    if (!question || options.length < 2) {
      return JSON.stringify({
        success: false,
        error: 'create_poll needs a question and at least 2 options separated by "|"',
      });
    }

    let durationHours: number | undefined;
    if (params.duration_hours) {
      durationHours = Number(params.duration_hours);
    }
    const multi = isYes(params.multi);
    // Gateway's POST /api/channels/:id/polls, in-process since wave 9
    const resp = await gateway.createPoll(channelId, {
      question,
      options,
      durationHours,
      allowMultiselect: multi,
    });
    const data = bodyOf(resp);
    if (!gateway.isOk(resp) || !data.success) {
      return JSON.stringify({ success: false, error: errorOf(data, 'poll creation failed') });
    }

    const messageId = String(data.messageId);
    lastPollByChannel.set(channelId, messageId);
    logger.info(`[poll] Created poll in ${channelId} (multi=${multi}): "${question}"`);
    const losses = optionLosses(options);
    const result: Record<string, unknown> = {
      success: true,
      message: `Poll is live: "${question}" (${Math.min(options.length, MAX_OPTIONS)} options, ${data.durationHours}h, ${picksLabel(multi)})`,
      messageId,
      multi,
    };
    if (losses.dropped.length > 0) {
      result.dropped_options = losses.dropped;
    }
    if (losses.shortened.length > 0) {
      result.shortened_options = losses.shortened.map((o) => `${o.slice(0, MAX_OPTION_CHARS)}…`);
    }
    if (losses.dropped.length > 0 || losses.shortened.length > 0) {
      result.note = `Discord allows ${MAX_OPTIONS} options of ${MAX_OPTION_CHARS} characters; the options listed here did not make it in whole.`;
    }
    return JSON.stringify(result);
  } catch (error) {
    logger.error('[poll] failed:', error);
    return JSON.stringify({ success: false, error: 'poll request failed — discord service may be down' });
  }
}

export const discordPollCapability: RegisteredCapability = {
  name: 'discord-poll',
  emoji: '🗳️',
  supportedActions: ['create_poll', 'read_poll', 'end_poll'],
  actions: {
    create_poll: {
      effect: 'discord',
      params: {
        channelId: {
          type: 'string',
          description: 'Post it in another channel of this server ("#name" or id); default: this channel',
          aliases: ['channel_id'],
        },
        question: { type: 'string', description: 'The poll question (up to 300 characters)', required: true },
        options: {
          type: 'string',
          description: `The answers, separated by "|" (2-${MAX_OPTIONS}, up to ${MAX_OPTION_CHARS} characters each)`,
          required: true,
        },
        duration_hours: { type: 'integer', description: 'How long the poll stays open (default 24, max 768)' },
        multi: {
          type: 'boolean',
          description:
            'true lets people pick more than one answer. Use it whenever you ask people to "pick all that ' +
            'work" (scheduling, availability, "which of these do you like"). Default false: one pick each.',
          aliases: ['multiselect', 'allow_multiselect', 'multiple'],
        },
      },
    },
    read_poll: {
      effect: 'read',
      params: {
        message_id: {
          type: 'string',
          description: 'The poll message id (default: the poll you last created in this channel)',
          aliases: ['messageId'],
        },
        channelId: { type: 'string', description: 'Channel the poll is in; default: this channel', aliases: ['channel_id'] },
      },
    },
    end_poll: {
      effect: 'discord',
      params: {
        message_id: {
          type: 'string',
          description: 'YOUR poll\'s message id (default: the poll you last created in this channel)',
          aliases: ['messageId'],
        },
        channelId: { type: 'string', description: 'Channel the poll is in; default: this channel', aliases: ['channel_id'] },
      },
    },
  },
  description:
    'Native Discord polls. create_poll: a question and options (2-10, separated by "|"), for votes, ' +
    'scheduling, tagline picks, standings. Set multi=true when people should pick more than one (any ' +
    '"pick all that work" poll). The result says single or multiple choice and lists any option Discord ' +
    'cut; say so honestly. read_poll: live tallies, who voted for what, and whether it is still open. ' +
    'end_poll: close one of YOUR polls now (the results freeze; to take a broken poll down entirely, ' +
    'discord-send-message delete_message). Channels cap how many of your polls can be active at once.',
  requiredParams: [],
  examples: [
    '<capability name="discord-poll" action="create_poll" question="Best launch tagline?" options="Build the city it deserves | Every great city runs on rails | Wishlist the commute" />',
    '<capability name="discord-poll" action="create_poll" question="Which nights work for the playtest? Pick all that work" options="Sat 8pm ET | Sun 2pm ET | Tue 7pm ET" duration_hours="72" multi="true" />',
    '<capability name="discord-poll" action="read_poll" message_id="1520088794551025684" />',
    '<capability name="discord-poll" action="end_poll" />',
  ],

  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    pollHandler(params, context),
};

// Remember the last poll Artie made per channel so read_poll works without an explicit id.
const lastPollByChannel = new Map<string, string>();

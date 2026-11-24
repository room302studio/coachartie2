/**
 * Trusted ids: the server, channel and person a tool call is ACTUALLY about, as opposed to ids
 * the model wrote into its parameters (EJ, 2026-11-23: "be strict as fuck").
 *
 * The leaks fixed on 2026-11-23 were all one bug: a handler took `params: any`, and a
 * model-written guildId looked exactly like the conversation's. With these brands, a gateway
 * entry point that scopes by server takes a TrustedGuildId, and a plain string (or anything
 * from params) does not compile there. The only way to get one is mintTrusted(), which names
 * its source; tests/engine/trusted-ids.test.ts pins every file allowed to call it, so a new
 * trust boundary is a reviewed edit, never an accident.
 */

declare const trustedBrand: unique symbol;

export type TrustedGuildId = string & { readonly [trustedBrand]: 'guild' };
export type TrustedChannelId = string & { readonly [trustedBrand]: 'channel' };
export type TrustedUserId = string & { readonly [trustedBrand]: 'user' };

/** Where trusted ids come from. Each value is a reviewed trust boundary. */
type TrustSource =
  /** The live Discord turn: the gateway saw the message in this guild/channel from this user. */
  | 'discord-turn'
  /** Replaying a call EJ approved: the ids were trusted when the original call was gated. */
  | 'approval-replay'
  /** The local engine HTTP API (127.0.0.1 only): its caller is our own process or EJ's tooling. */
  | 'local-api'
  /** A job the engine itself scheduled, from ids recorded when it was scheduled. */
  | 'engine-job'
  /** EJ, in his own DM, naming a server for an owner-only action. */
  | 'owner-dm-choice';

interface RawContextIds {
  guildId?: unknown;
  channelId?: unknown;
  userId?: unknown;
  messageId?: unknown;
}

export interface TrustedContextIds {
  guildId?: TrustedGuildId;
  channelId?: TrustedChannelId;
  userId?: TrustedUserId;
  messageId?: string;
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * Mint trusted ids. The `source` argument is required and is the reason this is allowed; keep
 * calls at the edges where ids genuinely come from Discord or EJ, never inside a tool handler.
 */
export function mintTrusted(raw: RawContextIds, _source: TrustSource): TrustedContextIds {
  const out: TrustedContextIds = {};
  const guildId = idString(raw.guildId);
  if (guildId) {
    out.guildId = guildId as TrustedGuildId;
  }
  const channelId = idString(raw.channelId);
  if (channelId) {
    out.channelId = channelId as TrustedChannelId;
  }
  const userId = idString(raw.userId);
  if (userId) {
    out.userId = userId as TrustedUserId;
  }
  const messageId = idString(raw.messageId);
  if (messageId) {
    out.messageId = messageId;
  }
  return out;
}

/** One trusted guild id (owner DM choice), or undefined for anything that isn't an id. */
export function mintTrustedGuild(raw: unknown, source: TrustSource): TrustedGuildId | undefined {
  return mintTrusted({ guildId: raw }, source).guildId;
}

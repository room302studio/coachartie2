import { logger, isBlockedUser, isGenerationMuted, getChannelDigest, setChannelDigestCursor } from '@coachartie/shared';
import { Client, Collection, Message, TextChannel } from 'discord.js';
import fetch from 'node-fetch';
import { GUILD_CONFIGS, GuildConfig } from '../config/guild-whitelist.js';

/**
 * Channel digest loop: keeps one rolling summary per observed channel so that when someone
 * @'s Artie, he knows what the room's been on about without paying for a long transcript or
 * a pile of recalled memories. The LLM call and writes live in capabilities
 * (services/core/channel-digest.ts); this side only decides WHEN a channel is worth a refresh.
 *
 * A refresh runs only when BOTH hold:
 *  - enough new human messages: DIGEST_MIN_MESSAGES (default 30), or DIGEST_STALE_MIN_MESSAGES
 *    (default 8) once the current digest is DIGEST_STALE_HOURS (default 12) old, so quiet
 *    channels still get a picture eventually; and
 *  - DIGEST_MIN_INTERVAL_MIN (default 30) since this channel's last refresh, so a hyperactive
 *    channel costs at most two cheap calls an hour.
 * Below the bar the cursor stays put and messages accumulate. The cursor is persisted in the
 * digest row, so a restart neither re-summarizes nor skips anything.
 *
 * Scope: each guild's observationChannels (an empty list means every viewable text channel).
 * CHANNEL_DIGEST_ENABLED=false turns it off. Nothing runs while generation is muted.
 */

const num = (v: string | undefined, d: number) => {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export interface DigestThresholds {
  minMessages: number;
  staleMinMessages: number;
  staleMs: number;
  minIntervalMs: number;
}

export function digestThresholds(env: NodeJS.ProcessEnv = process.env): DigestThresholds {
  return {
    minMessages: num(env.DIGEST_MIN_MESSAGES, 30),
    staleMinMessages: num(env.DIGEST_STALE_MIN_MESSAGES, 8),
    staleMs: num(env.DIGEST_STALE_HOURS, 12) * 3600_000,
    minIntervalMs: num(env.DIGEST_MIN_INTERVAL_MIN, 30) * 60_000,
  };
}

/** Pure decision: should this batch be folded into the digest now? */
export function shouldRefreshDigest(
  humanCount: number,
  lastUpdatedMs: number,
  nowMs: number,
  batchFull: boolean,
  t: DigestThresholds = digestThresholds()
): boolean {
  if (humanCount === 0) return false;
  const age = nowMs - lastUpdatedMs;
  if (age < t.minIntervalMs) return false;
  if (batchFull) return true; // waiting longer can't make the batch smaller
  if (humanCount >= t.minMessages) return true;
  return age >= t.staleMs && humanCount >= t.staleMinMessages;
}

export function isChannelDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHANNEL_DIGEST_ENABLED !== 'false';
}

const FETCH_LIMIT = 100;
const TICK_MS = num(process.env.DIGEST_TICK_MIN, 10) * 60_000;
const CAPABILITIES_URL = process.env.CAPABILITIES_URL || 'http://localhost:47324';

function observedChannels(client: Client, cfg: GuildConfig): TextChannel[] {
  const guild = client.guilds.cache.get(cfg.id);
  if (!guild || cfg.observationChannels === undefined) return [];
  const wanted = cfg.observationChannels.map((c) => c.toLowerCase());
  return [...guild.channels.cache.values()].filter(
    (ch): ch is TextChannel =>
      ch.type === 0 &&
      ch.viewable &&
      (wanted.length === 0 || wanted.some((w) => ch.name.toLowerCase().includes(w)))
  );
}

export class ChannelDigestLoop {
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  initialize(client: Client): void {
    this.client = client;
    if (!isChannelDigestEnabled()) {
      logger.info('📰 Channel digests OFF (CHANNEL_DIGEST_ENABLED=false)');
      return;
    }
    // Without the MessageContent intent every fetched message is blank (see index.ts).
    if (process.env.DISCORD_PRIVILEGED_INTENTS !== 'true') {
      logger.info('📰 Channel digests idle: no MessageContent intent (DISCORD_PRIVILEGED_INTENTS)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 15_000);
    logger.info(`📰 Channel digests on (tick ${TICK_MS / 60000}m)`, digestThresholds());
  }

  private async tick(): Promise<void> {
    if (!this.client || this.running || isGenerationMuted()) return;
    this.running = true;
    try {
      for (const cfg of Object.values(GUILD_CONFIGS)) {
        for (const channel of observedChannels(this.client, cfg)) {
          await this.processChannel(cfg, channel).catch((err) =>
            logger.warn(`📰 Digest failed for #${channel.name}:`, err)
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async processChannel(cfg: GuildConfig, channel: TextChannel): Promise<void> {
    const existing = getChannelDigest(channel.id);

    // First sight: seed the cursor at "now". Never summarize history we weren't around for.
    if (!existing?.lastMessageId) {
      const latest = (await channel.messages.fetch({ limit: 1 })).first();
      if (latest) setChannelDigestCursor(cfg.id, channel.id, channel.name, latest.id);
      return;
    }

    const lastUpdatedMs = new Date(existing.updatedAt).getTime();
    if (Date.now() - lastUpdatedMs < digestThresholds().minIntervalMs) return;

    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: FETCH_LIMIT,
      after: existing.lastMessageId,
    });
    if (batch.size === 0) return;

    const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const newest = ordered[ordered.length - 1];
    const humans = ordered.filter(
      (m) => !m.author.bot && !isBlockedUser(m.author.id) && m.content.trim().length > 0
    );

    if (humans.length === 0) {
      // All bots / blocked / empty: nothing to learn, just move past it.
      setChannelDigestCursor(cfg.id, channel.id, channel.name, newest.id);
      return;
    }
    if (!shouldRefreshDigest(humans.length, lastUpdatedMs, Date.now(), batch.size >= FETCH_LIMIT)) {
      return;
    }

    const lines = humans.map((m) => `${m.author.username}: ${m.content.replace(/\s+/g, ' ').trim()}`);
    const res = await fetch(`${CAPABILITIES_URL}/api/channel-digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guildId: cfg.id,
        guildName: cfg.name,
        channelId: channel.id,
        channelName: channel.name,
        lines,
        lastMessageId: newest.id,
      }),
    });
    if (!res.ok) logger.warn(`📰 Digest #${channel.name}: capabilities ${res.status}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const channelDigestLoop = new ChannelDigestLoop();

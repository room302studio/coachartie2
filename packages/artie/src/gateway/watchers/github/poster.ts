/**
 * Posts GitHub events to Discord. This file is the I/O half: fetch a headline, render, send, and
 * fall back to the studio feed when a channel refuses. What a card SAYS lives in cards.ts.
 */
import { Client, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { logger } from '../../../shared/logger.js';
import { GITHUB_FEED_CHANNEL_ID } from '../../../shared/config/channels.js';
import type { GitHubSyncEvent } from './poller.js';
import type { ProcessedEvent, BatchedEvents, DiscordMention } from './event-batcher.js';
import * as engine from '../../../engine/api.js';
import {
  BATCH_HEADLINE_TYPES,
  BATCH_LINES_SHOWN,
  cardToEmbed,
  headlineRequestFor,
  renderBatchCard,
  renderCard,
} from './cards.js';

/** Discord: Missing Access / Missing Permissions. */
const NO_ACCESS_CODES = [50001, 50013];

export class GitHubDiscordPoster {
  constructor(private client: Client) {}

  async postEvent(processed: ProcessedEvent): Promise<void> {
    if (!processed.shouldPost) {
      logger.debug(`Skipping event: ${processed.skipReason}`);
      return;
    }

    const channel = await this.getChannel(processed.event.channelId);
    if (!channel) {
      logger.error(`Channel ${processed.event.channelId} not found`);
      return;
    }

    const headline = await this.headlineFor(processed.event);
    const embed = cardToEmbed(renderCard(processed.event, headline));
    const content = formatMentions(processed.mentions);

    try {
      await channel.send({ content: content || undefined, embeds: [embed] });
      logger.info(`Posted ${processed.event.type} event to ${channel.id}`);
    } catch (error) {
      logger.error(`Failed to post event to ${channel.id}:`, error);
      // The watch points somewhere Artie can't post. Don't drop the event; put it in the
      // studio-wide feed (2026-10-22: a PR comment was lost this way after a channel move).
      const code = (error as { code?: number })?.code;
      if (code !== undefined && NO_ACCESS_CODES.includes(code) && channel.id !== GITHUB_FEED_CHANNEL_ID) {
        const feed = await this.getChannel(GITHUB_FEED_CHANNEL_ID);
        if (feed) {
          let mentionSuffix = '';
          if (content) {
            mentionSuffix = `\n${content}`;
          }
          await feed
            .send({ content: `couldn't post in <#${channel.id}> (no access), so here:${mentionSuffix}`, embeds: [embed] })
            .catch((e) => logger.error('Fallback post to the GitHub feed also failed:', e));
        }
      }
    }
  }

  async postBatch(batch: BatchedEvents): Promise<void> {
    if (batch.events.length === 1) {
      await this.postEvent(batch.events[0]);
      return;
    }

    const channel = await this.getChannel(batch.channelId);
    if (!channel) {
      logger.error(`Channel ${batch.channelId} not found`);
      return;
    }

    // Headlines only for the lines that are shown and render one, fetched in parallel.
    const headlines = await Promise.all(
      batch.events.slice(0, BATCH_LINES_SHOWN).map((e) => {
        if (BATCH_HEADLINE_TYPES.has(e.event.type)) {
          return this.headlineFor(e.event);
        }
        return Promise.resolve(null);
      })
    );
    const embed = cardToEmbed(renderBatchCard(batch.events, headlines));
    const content = formatMentions(collectMentions(batch.events));

    try {
      await channel.send({ content: content || undefined, embeds: [embed] });
      logger.info(`Posted batch with ${batch.events.length} events to ${channel.id}`);
    } catch (error) {
      logger.error(`Failed to post batch to ${channel.id}:`, error);
    }
  }

  /** Never throws and never blocks a post: no headline → the card shows the plain title. */
  private async headlineFor(event: GitHubSyncEvent): Promise<string | null> {
    const req = headlineRequestFor(event);
    if (!req) {
      return null;
    }
    try {
      return await engine.githubHeadline({ ...req, guildId: event.guildId });
    } catch {
      return null;
    }
  }

  private async getChannel(channelId: string): Promise<TextChannel | NewsChannel | ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel instanceof TextChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel) {
        return channel;
      }
      return null;
    } catch (error) {
      logger.error(`Failed to fetch channel ${channelId}:`, error);
      return null;
    }
  }
}

function formatMentions(mentions: DiscordMention[]): string {
  const tags = mentions.map((m) => {
    if (m.type === 'user') {
      return `<@${m.id}>`;
    }
    return `<@&${m.id}>`;
  });
  return [...new Set(tags)].join(' ');
}

function collectMentions(events: ProcessedEvent[]): DiscordMention[] {
  const seen = new Set<string>();
  const mentions: DiscordMention[] = [];
  for (const event of events) {
    for (const mention of event.mentions) {
      const key = `${mention.type}:${mention.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(mention);
      }
    }
  }
  return mentions;
}

export function initializeDiscordPoster(client: Client): GitHubDiscordPoster {
  logger.info('GitHub Discord poster initialized');
  return new GitHubDiscordPoster(client);
}

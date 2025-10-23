/**
 * Discord Forum Traversal Service
 *
 * Provides utilities for discovering, reading, and processing Discord Forum channels
 * (aka Discussions). Supports bulk operations for syncing to external systems.
 *
 * Features:
 * - List all forums in a guild
 * - Fetch all threads from a forum
 * - Read all messages in a thread
 * - Aggregate thread data with metadata
 */

import { Client, ChannelType, ForumChannel, ThreadChannel, Message, Collection } from 'discord.js';
import { logger } from '@coachartie/shared';

export interface ForumThreadData {
  threadId: string;
  threadName: string;
  threadTags: string[];
  createdAt: Date;
  ownerId: string;
  ownerName: string;
  messageCount: number;
  isLocked: boolean;
  isArchived: boolean;
  messages: ThreadMessageData[];
  starterMessage?: ThreadMessageData;
}

export interface ThreadMessageData {
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: Date;
  attachments: string[];
  reactions: { emoji: string; count: number }[];
}

export interface ForumSummary {
  forumId: string;
  forumName: string;
  threadCount: number;
  threads: ForumThreadData[];
}

/**
 * Forum Traversal Service - Navigate Discord Forums programmatically
 */
export class ForumTraversalService {
  constructor(private client: Client) {}

  /**
   * Get all forum channels in a guild
   */
  async getForumsInGuild(guildId: string): Promise<ForumChannel[]> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channels = await guild.channels.fetch();

      const forums = channels
        .filter((channel) => channel?.type === ChannelType.GuildForum)
        .map((channel) => channel as ForumChannel);

      logger.info(`Found ${forums.length} forum channels in guild ${guild.name}`);
      return forums;
    } catch (error) {
      logger.error(`Failed to fetch forums in guild ${guildId}:`, error);
      throw error;
    }
  }

  /**
   * Get all threads from a forum channel
   * Includes both active and archived threads
   */
  async getThreadsInForum(forumId: string): Promise<ThreadChannel[]> {
    try {
      const forum = (await this.client.channels.fetch(forumId)) as ForumChannel;

      if (forum.type !== ChannelType.GuildForum) {
        throw new Error(`Channel ${forumId} is not a forum channel`);
      }

      // Fetch active threads
      const activeThreads = await forum.threads.fetchActive();

      // Fetch archived threads
      const archivedThreads = await forum.threads.fetchArchived();

      const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];

      logger.info(
        `Found ${allThreads.length} threads in forum ${forum.name} (${activeThreads.threads.size} active, ${archivedThreads.threads.size} archived)`
      );
      return allThreads;
    } catch (error) {
      logger.error(`Failed to fetch threads in forum ${forumId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch all messages from a thread
   * Handles pagination automatically
   */
  async getMessagesInThread(threadId: string, limit?: number): Promise<Message[]> {
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel;

      if (!thread.isThread()) {
        throw new Error(`Channel ${threadId} is not a thread`);
      }

      const messages: Message[] = [];
      let lastMessageId: string | undefined;
      const batchSize = 100; // Discord API limit

      while (true) {
        const batch = await thread.messages.fetch({
          limit: limit ? Math.min(batchSize, limit - messages.length) : batchSize,
          before: lastMessageId,
        });

        if (batch.size === 0) break;

        messages.push(...batch.values());
        lastMessageId = batch.last()?.id;

        // Check if we've hit the limit
        if (limit && messages.length >= limit) break;

        // Check if we got fewer messages than requested (end of history)
        if (batch.size < batchSize) break;
      }

      logger.info(`Fetched ${messages.length} messages from thread ${thread.name}`);
      return messages.reverse(); // Chronological order
    } catch (error) {
      logger.error(`Failed to fetch messages in thread ${threadId}:`, error);
      throw error;
    }
  }

  /**
   * Get complete thread data with all messages and metadata
   */
  async getThreadData(threadId: string): Promise<ForumThreadData> {
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel;
      const messages = await this.getMessagesInThread(threadId);

      // Get thread owner info
      const owner = await thread.guild?.members.fetch(thread.ownerId!);

      // Get starter message (first message in thread)
      const starterMessage = messages[0];

      const threadData: ForumThreadData = {
        threadId: thread.id,
        threadName: thread.name,
        threadTags: thread.appliedTags || [],
        createdAt: thread.createdAt!,
        ownerId: thread.ownerId!,
        ownerName: owner?.user.username || 'Unknown',
        messageCount: messages.length,
        isLocked: thread.locked || false,
        isArchived: thread.archived || false,
        messages: messages.map((msg) => this.formatMessage(msg)),
        starterMessage: starterMessage ? this.formatMessage(starterMessage) : undefined,
      };

      logger.info(`Compiled thread data for "${thread.name}" (${messages.length} messages)`);
      return threadData;
    } catch (error) {
      logger.error(`Failed to get thread data for ${threadId}:`, error);
      throw error;
    }
  }

  /**
   * Get all threads from a forum with complete data
   */
  async getForumSummary(forumId: string): Promise<ForumSummary> {
    try {
      const forum = (await this.client.channels.fetch(forumId)) as ForumChannel;
      const threads = await this.getThreadsInForum(forumId);

      logger.info(`Compiling data for ${threads.length} threads in forum ${forum.name}...`);

      const threadDataPromises = threads.map((thread) =>
        this.getThreadData(thread.id).catch((error) => {
          logger.warn(`Failed to fetch data for thread ${thread.name}:`, error);
          return null;
        })
      );

      const threadData = (await Promise.all(threadDataPromises)).filter(
        (t): t is ForumThreadData => t !== null
      );

      const summary: ForumSummary = {
        forumId: forum.id,
        forumName: forum.name,
        threadCount: threadData.length,
        threads: threadData,
      };

      logger.info(
        `Forum summary complete for ${forum.name}: ${threadData.length} threads processed`
      );
      return summary;
    } catch (error) {
      logger.error(`Failed to create forum summary for ${forumId}:`, error);
      throw error;
    }
  }

  /**
   * Format a Discord message into a simplified data structure
   */
  private formatMessage(message: Message): ThreadMessageData {
    return {
      messageId: message.id,
      authorId: message.author.id,
      authorName: message.author.username,
      content: message.content,
      createdAt: message.createdAt,
      attachments: message.attachments.map((att) => att.url),
      reactions: message.reactions.cache.map((reaction) => ({
        emoji: reaction.emoji.name || reaction.emoji.toString(),
        count: reaction.count,
      })),
    };
  }
}

/**
 * Global forum traversal service instance
 * Initialized when Discord client is ready
 */
let forumTraversalService: ForumTraversalService | null = null;

export function initializeForumTraversal(client: Client): ForumTraversalService {
  forumTraversalService = new ForumTraversalService(client);
  logger.info('Forum traversal service initialized');
  return forumTraversalService;
}

export function getForumTraversal(): ForumTraversalService {
  if (!forumTraversalService) {
    throw new Error(
      'Forum traversal service not initialized. Call initializeForumTraversal first.'
    );
  }
  return forumTraversalService;
}

import { logger } from '@coachartie/shared';
import { Message } from 'discord.js';
import fetch from 'node-fetch';

/**
 * Observational Learning Service
 * Collects and summarizes messages from "watching" guilds to form passive memories
 */

interface MessageBatch {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  messages: {
    author: string;
    content: string;
    timestamp: Date;
  }[];
  startTime: Date;
  endTime: Date;
}

export class ObservationalLearning {
  private static instance: ObservationalLearning;
  private messageBatches: Map<string, MessageBatch> = new Map();
  private processingTimer: NodeJS.Timer | null = null;

  // Configuration
  private readonly BATCH_SIZE = parseInt(process.env.OBSERVATION_BATCH_SIZE || '20');
  private readonly BATCH_TIME_MS = parseInt(process.env.OBSERVATION_BATCH_TIME_MS || '300000'); // 5 minutes
  private readonly ENABLE_OBSERVATION = process.env.ENABLE_OBSERVATIONAL_LEARNING === 'true';
  private readonly CAPABILITIES_URL = process.env.CAPABILITIES_URL || 'http://localhost:47324';

  private constructor() {
    if (this.ENABLE_OBSERVATION) {
      this.startBatchProcessing();
      logger.info('👁️ Observational learning initialized', {
        batchSize: this.BATCH_SIZE,
        batchTimeMs: this.BATCH_TIME_MS
      });
    }
  }

  static getInstance(): ObservationalLearning {
    if (!ObservationalLearning.instance) {
      ObservationalLearning.instance = new ObservationalLearning();
    }
    return ObservationalLearning.instance;
  }

  /**
   * Add a message to the observation batch
   */
  async observeMessage(message: Message): Promise<void> {
    if (!this.ENABLE_OBSERVATION) return;
    if (message.author.bot) return; // Don't observe bot messages

    const batchKey = `${message.guildId}-${message.channelId}`;

    if (!this.messageBatches.has(batchKey)) {
      this.messageBatches.set(batchKey, {
        guildId: message.guildId!,
        guildName: message.guild?.name || 'Unknown Guild',
        channelId: message.channelId,
        channelName: message.channel.type === 0 ? message.channel.name : 'Unknown Channel',
        messages: [],
        startTime: new Date(),
        endTime: new Date()
      });
    }

    const batch = this.messageBatches.get(batchKey)!;
    batch.messages.push({
      author: message.author.username,
      content: message.content.substring(0, 500), // Limit message length
      timestamp: new Date()
    });
    batch.endTime = new Date();

    // Process batch if it reaches size limit
    if (batch.messages.length >= this.BATCH_SIZE) {
      await this.processBatch(batchKey);
    }
  }

  /**
   * Start periodic batch processing
   */
  private startBatchProcessing(): void {
    this.processingTimer = setInterval(async () => {
      await this.processAllBatches();
    }, this.BATCH_TIME_MS);
  }

  /**
   * Process all pending batches
   */
  private async processAllBatches(): Promise<void> {
    const batchKeys = Array.from(this.messageBatches.keys());

    for (const key of batchKeys) {
      const batch = this.messageBatches.get(key);
      if (batch && batch.messages.length > 0) {
        await this.processBatch(key);
      }
    }
  }

  /**
   * Process a single batch and create observational memory
   */
  private async processBatch(batchKey: string): Promise<void> {
    const batch = this.messageBatches.get(batchKey);
    if (!batch || batch.messages.length === 0) return;

    try {
      logger.info(`👁️ Processing observation batch: ${batch.messages.length} messages from ${batch.channelName}`);

      // Create a summary prompt
      const conversationText = batch.messages
        .map(m => `${m.author}: ${m.content}`)
        .join('\n');

      const summaryPrompt = `Observe this Discord conversation from ${batch.guildName} #${batch.channelName} and extract key patterns:

Messages (${batch.messages.length} total):
${conversationText}

Summarize in 2-3 sentences:
1. Main topics or themes discussed
2. Any recurring questions or interests
3. Notable user behaviors or preferences

Focus on patterns that would help understand this community's needs and interests.`;

      // Call capabilities service to generate summary using FAST_MODEL
      const response = await fetch(`${this.CAPABILITIES_URL}/api/observe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: summaryPrompt,
          guildId: batch.guildId,
          channelId: batch.channelId,
          messageCount: batch.messages.length,
          timeRange: {
            start: batch.startTime.toISOString(),
            end: batch.endTime.toISOString()
          }
        })
      });

      if (response.ok) {
        const result = await response.json();
        logger.info(`👁️ Observation summary created: ${result.summary?.substring(0, 100)}...`);

        // Store as observational memory
        await this.storeObservationalMemory(batch, result.summary);
      } else {
        logger.warn(`👁️ Failed to generate observation summary: ${response.statusText}`);
      }

    } catch (error) {
      logger.error('👁️ Error processing observation batch:', error);
    } finally {
      // Clear the processed batch
      this.messageBatches.delete(batchKey);
    }
  }

  /**
   * Store the observation as a memory
   */
  private async storeObservationalMemory(
    batch: MessageBatch,
    summary: string
  ): Promise<void> {
    try {
      // Call memory capability to store observation
      const memoryResponse = await fetch(`${this.CAPABILITIES_URL}/capabilities/registry/memory/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'remember',
          params: {
            content: `[Observation from ${batch.guildName} #${batch.channelName}] ${summary}`,
            userId: 'observational-system',
            importance: 2,
            tags: [
              'observation',
              'passive-learning',
              batch.guildName.toLowerCase().replace(/\s+/g, '-'),
              batch.channelName.toLowerCase().replace(/\s+/g, '-')
            ]
          }
        })
      });

      if (memoryResponse.ok) {
        logger.info(`👁️ Stored observational memory for ${batch.guildName} #${batch.channelName}`);
      }
    } catch (error) {
      logger.error('👁️ Failed to store observational memory:', error);
    }
  }

  /**
   * Get statistics about current observations
   */
  getStats(): {
    activeBatches: number;
    totalMessages: number;
    batchDetails: Array<{
      key: string;
      messageCount: number;
      guildName: string;
      channelName: string;
    }>;
  } {
    const batchDetails = Array.from(this.messageBatches.entries()).map(([key, batch]) => ({
      key,
      messageCount: batch.messages.length,
      guildName: batch.guildName,
      channelName: batch.channelName
    }));

    return {
      activeBatches: this.messageBatches.size,
      totalMessages: batchDetails.reduce((sum, b) => sum + b.messageCount, 0),
      batchDetails
    };
  }

  /**
   * Cleanup and shutdown
   */
  shutdown(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    // Process any remaining batches
    this.processAllBatches().catch(error => {
      logger.error('Error processing final batches:', error);
    });
  }
}

export const observationalLearning = ObservationalLearning.getInstance();
import { Client, Events, Message } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { capabilitiesClient } from '../services/capabilities-client.js';
import { telemetry } from '../services/telemetry.js';
import { CorrelationContext, generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';

// Simple deduplication cache to prevent duplicate message processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds

// Helper function to split content into paragraph-based chunks for streaming
function splitIntoParagraphs(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  
  // Split on double linebreaks (natural paragraph breaks)
  let paragraphs = text.split('\n\n');
  
  // If no double linebreaks, split on single linebreaks for bullet points/lists
  if (paragraphs.length === 1 && text.includes('\n')) {
    paragraphs = text.split('\n').filter(p => p.trim().length > 0);
  }
  
  // If still no breaks, split on sentences for very long single paragraphs
  if (paragraphs.length === 1 && text.length > 500) {
    // Split on sentence endings but keep them attached
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    paragraphs = sentences.map(s => s.trim()).filter(s => s.length > 0);
  }
  
  // Group small paragraphs together to avoid too many tiny messages
  const groupedParagraphs: string[] = [];
  let currentGroup = '';
  
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    
    // If adding this paragraph would make the group too long, start a new group
    if (currentGroup && (currentGroup.length + trimmed.length > 800)) {
      groupedParagraphs.push(currentGroup.trim());
      currentGroup = trimmed;
    } else {
      currentGroup += (currentGroup ? '\n\n' : '') + trimmed;
    }
  }
  
  // Don't forget the last group
  if (currentGroup.trim()) {
    groupedParagraphs.push(currentGroup.trim());
  }
  
  return groupedParagraphs;
}

// Helper function to chunk long messages for Discord's 2000 character limit
function chunkMessage(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by lines first to preserve formatting
  const lines = text.split('\n');
  
  for (const line of lines) {
    // If adding this line would exceed the limit, start a new chunk
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If a single line is too long, split it further
      if (line.length > maxLength) {
        const words = line.split(' ');
        for (const word of words) {
          if (currentChunk.length + word.length + 1 > maxLength) {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
              currentChunk = '';
            }
          }
          currentChunk += (currentChunk ? ' ' : '') + word;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Generate correlation ID for this message
    const correlationId = CorrelationContext.getForMessage(message.id);
    const shortId = getShortCorrelationId(correlationId);
    
    // Structured logging with correlation ID
    logger.info(`📨 Message received [${shortId}]`, {
      correlationId,
      author: message.author.tag,
      userId: message.author.id,
      channelType: message.channel.type,
      channelId: message.channelId,
      messageId: message.id,
      contentLength: message.content.length,
      guildId: message.guildId || 'DM'
    });
    
    // Track message received
    telemetry.incrementMessagesReceived(message.author.id);
    telemetry.logEvent('message_received', {
      channelType: message.channel.type,
      guildId: message.guildId,
      contentLength: message.content.length
    }, correlationId, message.author.id);
    
    // Ignore our own messages to prevent loops, but observe other bots (GitHub, webhooks, etc.)
    if (message.author.id === client.user!.id) return;

    // Check response conditions
    const botMentioned = message.mentions.has(client.user!.id);
    const isDM = message.channel.isDMBased();
    const isRobotChannel = message.channel.type === 0 && 'name' in message.channel && 
      (message.channel.name?.includes('🤖') || message.channel.name?.includes('robot'));
    
    // Determine if we should respond vs just observe
    const shouldRespond = botMentioned || isDM || isRobotChannel;

    try {
      // Always process the full message for passive observation
      const fullMessage = message.content;
      
      // Clean message for response (remove bot mentions)
      const cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '')
        .replace(`<@!${client.user!.id}>`, '')
        .trim();

      // Deduplication check: prevent processing the same message twice
      const messageKey = `${message.author.id}-${fullMessage}-${message.channelId}`;
      const now = Date.now();
      
      // Clean up old cache entries
      for (const [key, timestamp] of messageCache.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          messageCache.delete(key);
        }
      }
      
      // Check if we've seen this exact message recently
      if (messageCache.has(messageKey)) {
        logger.info(`🚫 Duplicate message detected [${shortId}]`, { correlationId, messageKey });
        telemetry.logEvent('message_duplicate', { messageKey }, correlationId, message.author.id);
        return;
      }
      
      // Cache this message
      messageCache.set(messageKey, now);

      // Handle response vs passive observation
      if (shouldRespond) {
        logger.info(`🤖 Will respond to message [${shortId}]`, {
          correlationId,
          author: message.author.tag,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : '')
        });
        
        telemetry.logEvent('message_will_respond', {
          messageLength: cleanMessage.length,
          triggerType: botMentioned ? 'mention' : isDM ? 'dm' : 'robot_channel'
        }, correlationId, message.author.id);
        
        // Start typing indicator and process with job tracking
        await handleResponseWithJobTracking(message, cleanMessage, correlationId);
      } else {
        const channelName = message.channel.type === 0 && 'name' in message.channel ? message.channel.name : 'DM';
        logger.info(`👁️ Passive observation [${shortId}]`, {
          correlationId,
          author: message.author.tag,
          channel: channelName
        });
        
        telemetry.logEvent('message_observed', {
          channelName,
          messageLength: fullMessage.length
        }, correlationId, message.author.id);
        
        // Still process for passive observation using queue system
        await publishMessage(
          message.author.id,
          fullMessage,
          message.channelId,
          message.author.tag,
          false // Don't respond, just observe
        );
      }

    } catch (error) {
      logger.error(`❌ Error handling Discord message [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        author: message.author.tag,
        messageId: message.id
      });
      
      telemetry.incrementMessagesFailed(message.author.id, error instanceof Error ? error.message : String(error));
      telemetry.logEvent('message_error', {
        error: error instanceof Error ? error.message : String(error)
      }, correlationId, message.author.id, undefined, false);
      
      await message.reply(`Sorry, I encountered an error processing your message. [${shortId}]`);
    }
    
    // Clean up correlation context periodically
    if (Math.random() < 0.01) { // 1% chance
      CorrelationContext.cleanup();
    }
  });
}

/**
 * Handle Discord message with job tracking and live updates
 */
async function handleResponseWithJobTracking(message: Message, cleanMessage: string, correlationId: string): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  const startTime = Date.now();
  let typingInterval: NodeJS.Timeout | null = null;
  let statusMessage: Message | null = null;

  try {
    // Start continuous typing indicator
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
      telemetry.incrementTypingIndicators();
      telemetry.logEvent('typing_started', {}, correlationId, message.author.id);
      
      // Keep typing indicator alive during processing
      typingInterval = setInterval(async () => {
        try {
          if ('sendTyping' in message.channel) {
            await message.channel.sendTyping();
            telemetry.incrementTypingIndicators();
          }
        } catch (error) {
          logger.error(`❌ Failed to send typing indicator [${shortId}]:`, {
            correlationId,
            error: error instanceof Error ? error.message : String(error)
          });
          telemetry.incrementApiErrors(error instanceof Error ? error.message : String(error));
        }
      }, 8000); // Refresh every 8 seconds (Discord typing lasts 10 seconds)
    }

    // Submit job and get immediate response
    const jobInfo = await capabilitiesClient.submitJob(cleanMessage, message.author.id);
    logger.info(`🤖 Job submitted [${shortId}]`, {
      correlationId,
      jobId: jobInfo.messageId,
      author: message.author.tag,
      messageLength: cleanMessage.length
    });
    
    telemetry.incrementJobsSubmitted(message.author.id, jobInfo.messageId);
    telemetry.logEvent('job_submitted', {
      jobId: jobInfo.messageId,
      messageLength: cleanMessage.length
    }, correlationId, message.author.id);

    // Send initial status message
    const jobShortId = jobInfo.messageId.slice(-8);
    statusMessage = await message.reply(`🤔 Working on it... (${shortId}/${jobShortId})`);

    let lastStatus = 'pending';
    let updateCount = 0;
    let lastSentLength = 0; // Track how much content we've already sent
    let streamingMessages: Message[] = []; // Track messages we've sent for streaming
    let lastStreamSendTime = 0; // Track rate limiting for streaming
    const STREAM_RATE_LIMIT = 2000; // Minimum 2 seconds between stream updates

    // Poll for completion with live updates
    const result = await capabilitiesClient.pollJobUntilComplete(jobInfo.messageId, {
      maxAttempts: 60, // 5 minutes max
      pollInterval: 3000, // 3 seconds for responsive Discord UX
      
      onProgress: async (status) => {
        try {
          // Paragraph-based streaming - send new content as it arrives
          if (status.partialResponse && status.partialResponse.length > lastSentLength) {
            // Get only the new content since last update
            const newContent = status.partialResponse.substring(lastSentLength);
            
            // Rate limiting - don't spam Discord
            const now = Date.now();
            if (now - lastStreamSendTime < STREAM_RATE_LIMIT) {
              return; // Skip this update to avoid rate limits
            }
            
            // Split new content into paragraphs (double linebreaks or significant chunks)
            const paragraphs = splitIntoParagraphs(newContent);
            
            if (paragraphs.length > 0 && 'send' in message.channel && typeof message.channel.send === 'function') {
              // Send each paragraph as a separate message for better readability
              for (const paragraph of paragraphs) {
                if (paragraph.trim().length > 0) {
                  const chunks = chunkMessage(paragraph.trim());
                  for (const chunk of chunks) {
                    const sentMessage = await (message.channel as any).send(chunk);
                    streamingMessages.push(sentMessage);
                  }
                }
              }
              
              lastSentLength = status.partialResponse.length;
              lastStreamSendTime = now;
              logger.info(`📡 Sent ${paragraphs.length} streaming paragraphs [${shortId}]`);
            }
          }
          
          // Update status message
          const shouldUpdate = status.status !== lastStatus || (updateCount % 5 === 0);
          
          if (shouldUpdate && statusMessage) {
            const processingTime = Math.round(status.processingTime / 1000);
            const statusEmoji = status.status === 'processing' ? '🔄' : '🤔';
            const streamEmoji = status.partialResponse ? '📡' : '';
            const newContent = `${statusEmoji}${streamEmoji} ${status.status}... (${processingTime}s, ${shortId}/${jobShortId})`;
            
            await statusMessage.edit(newContent);
            lastStatus = status.status;
            
            telemetry.logEvent('status_updated', {
              status: status.status,
              processingTime: status.processingTime,
              updateCount
            }, correlationId, message.author.id);
          }
          updateCount++;
        } catch (error) {
          logger.error(`❌ Failed to update status message [${shortId}]:`, {
            correlationId,
            error: error instanceof Error ? error.message : String(error)
          });
          telemetry.incrementApiErrors(error instanceof Error ? error.message : String(error));
        }
      },

      onComplete: async (result) => {
        try {
          const duration = Date.now() - startTime;
          
          // Stop typing and clear status message
          if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
          }

          if (statusMessage) {
            // Edit status message to show completion
            await statusMessage.edit(`✅ Complete! (${shortId}/${jobShortId})`);
            
              // Send any remaining content that wasn't streamed
            if (lastSentLength < result.length) {
              const remainingContent = result.substring(lastSentLength);
              if (remainingContent.trim().length > 0) {
                const chunks = chunkMessage(remainingContent.trim());
                
                if ('send' in message.channel && typeof message.channel.send === 'function') {
                  for (const chunk of chunks) {
                    await (message.channel as any).send(chunk);
                  }
                } else {
                  await message.reply(chunks[0]);
                  for (let i = 1; i < chunks.length; i++) {
                    if ('send' in message.channel && typeof message.channel.send === 'function') {
                      await (message.channel as any).send(chunks[i]);
                    }
                  }
                }
                
                logger.info(`📡 Sent remaining content (${remainingContent.length} chars) [${shortId}]`);
              }
            }
            
            // Track total messages sent (streaming + remaining)
            const totalChunks = streamingMessages.length + (lastSentLength < result.length ? chunkMessage(result.substring(lastSentLength)).length : 0);
            telemetry.incrementResponsesDelivered(message.author.id, totalChunks)
          } else {
            // Fallback if status message failed - chunk the reply
            const chunks = chunkMessage(result);
            await message.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              if ('send' in message.channel && typeof message.channel.send === 'function') {
                await (message.channel as any).send(chunks[i]);
              }
            }
            
            telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
          }

          // Track completion metrics
          telemetry.incrementJobsCompleted(message.author.id, jobInfo.messageId, duration);
          telemetry.incrementMessagesProcessed(message.author.id, duration);
          
          logger.info(`✅ Discord job completed [${shortId}]`, {
            correlationId,
            jobId: jobInfo.messageId,
            author: message.author.tag,
            duration: `${duration}ms`,
            responseLength: result.length
          });
          
          telemetry.logEvent('job_completed', {
            jobId: jobInfo.messageId,
            duration,
            responseLength: result.length
          }, correlationId, message.author.id, duration, true);
          
        } catch (error) {
          logger.error(`❌ Failed to send completion message [${shortId}]:`, {
            correlationId,
            error: error instanceof Error ? error.message : String(error)
          });
          
          telemetry.incrementApiErrors(error instanceof Error ? error.message : String(error));
          
          // Fallback: try to reply directly with chunking
          try {
            const chunks = chunkMessage(`✅ ${result}`);
            await message.reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              if ('send' in message.channel && typeof message.channel.send === 'function') {
                await (message.channel as any).send(chunks[i]);
              }
            }
            telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
          } catch (fallbackError) {
            logger.error(`❌ Fallback reply also failed [${shortId}]:`, {
              correlationId,
              fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            });
            
            // Last resort: send a simple error message
            try {
              await message.reply(`✅ Response ready but too long for Discord. [${shortId}]`);
            } catch (lastResortError) {
              logger.error(`❌ Last resort error message failed [${shortId}]:`, {
                correlationId,
                lastResortError: lastResortError instanceof Error ? lastResortError.message : String(lastResortError)
              });
            }
          }
        }
      },

      onError: async (error) => {
        try {
          const duration = Date.now() - startTime;
          
          // Stop typing
          if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
          }

          // Update status message with error
          if (statusMessage) {
            await statusMessage.edit(`❌ Error: ${error} (${shortId}/${jobShortId})`);
          } else {
            await message.reply(`❌ Sorry, something went wrong: ${error} [${shortId}]`);
          }

          // Track error metrics
          telemetry.incrementJobsFailed(message.author.id, jobInfo.messageId, error, duration);
          telemetry.incrementMessagesFailed(message.author.id, error, duration);
          
          logger.error(`❌ Discord job failed [${shortId}]:`, {
            correlationId,
            jobId: jobInfo.messageId,
            author: message.author.tag,
            error,
            duration: `${duration}ms`
          });
          
          telemetry.logEvent('job_failed', {
            jobId: jobInfo.messageId,
            error,
            duration
          }, correlationId, message.author.id, duration, false);
          
        } catch (updateError) {
          logger.error(`❌ Failed to send error message [${shortId}]:`, {
            correlationId,
            updateError: updateError instanceof Error ? updateError.message : String(updateError)
          });
          telemetry.incrementApiErrors(updateError instanceof Error ? updateError.message : String(updateError));
        }
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Clean up on any error
    if (typingInterval) {
      clearInterval(typingInterval);
    }

    logger.error(`❌ Job tracking failed [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${duration}ms`
    });
    
    telemetry.incrementMessagesFailed(message.author.id, error instanceof Error ? error.message : String(error), duration);
    telemetry.logEvent('job_tracking_failed', {
      error: error instanceof Error ? error.message : String(error),
      duration
    }, correlationId, message.author.id, duration, false);

    try {
      if (statusMessage) {
        await statusMessage.edit(`❌ Failed to process: ${error instanceof Error ? error.message : String(error)} [${shortId}]`);
      } else {
        await message.reply(`❌ Sorry, I couldn't process your message: ${error instanceof Error ? error.message : String(error)} [${shortId}]`);
      }
    } catch (replyError) {
      logger.error(`❌ Failed to send error reply [${shortId}]:`, {
        correlationId,
        replyError: replyError instanceof Error ? replyError.message : String(replyError)
      });
      telemetry.incrementApiErrors(replyError instanceof Error ? replyError.message : String(replyError));
    }
  }
}
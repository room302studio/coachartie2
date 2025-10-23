/**
 * Universal User Intent Processor
 *
 * Single implementation for all Discord interactions:
 * - Messages, button clicks, menu selections, slash commands
 * - Handles job submission, monitoring, streaming, completion
 * - Provides consistent UX across all interaction types
 */

import { logger } from '@coachartie/shared';
import { capabilitiesClient } from './capabilities-client.js';
import { jobMonitor } from './job-monitor.js';
import { telemetry } from './telemetry.js';
import { generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';

export interface UserIntent {
  content: string;
  userId: string;
  username?: string;
  source: 'message' | 'button' | 'select' | 'slash_command';
  metadata?: Record<string, unknown>;
  context?: Record<string, any>; // Discord context for Context Alchemy
  respond: (content: string) => Promise<void>;
  updateProgress?: (status: string) => Promise<void>;
  sendTyping?: () => Promise<void>;
  // ENHANCED: Discord-native features
  addReaction?: (emoji: string) => Promise<void>;
  removeReaction?: (emoji: string) => Promise<void>;
  editResponse?: (content: string) => Promise<void>;
  createThread?: (name: string) => Promise<any>;
  sendEmbed?: (embed: any) => Promise<void>;
  updateProgressEmbed?: (embed: any) => Promise<void>;
}

export interface ProcessorOptions {
  enableStreaming?: boolean;
  enableTyping?: boolean;
  enableReactions?: boolean;
  enableEditing?: boolean;
  enableThreading?: boolean;
  maxAttempts?: number;
  statusUpdateInterval?: number;
}

/**
 * Clean capability tags and technical syntax from user-facing text
 * ENHANCED: Catches chain-of-thought leakage and internal reasoning
 */
function cleanCapabilityTags(text: string): string {
  // Remove XML capability tags and content
  text = text.replace(/<capability[^>]*>.*?<\/capability>/gs, '');
  text = text.replace(/<thinking[^>]*>.*?<\/thinking>/gs, '');
  text = text.replace(/<thinking[^>]*>.*?<\/antml:thinking>/gs, '');

  // Remove markdown-style capability indicators
  text = text.replace(/\[\w+\]\s*[^\[]*\[\/\w+\]/gs, '');

  // ENHANCED: Remove common LLM chain-of-thought patterns
  text = text.replace(/^(Let me|I'll|I need to|I should|I will|I'm going to)\s+.*?\.\s*/gim, '');
  text = text.replace(/^(First,|Next,|Then,|Now,|Finally,)\s+.*?\.\s*/gim, '');
  text = text.replace(/^(Looking at|Based on|Given that|Since)\s+.*?\.\s*/gim, '');

  // Remove reasoning phrases
  text = text.replace(
    /\b(Let me think about this|I think|I believe|It seems|It appears)\s+.*?\.\s*/gi,
    ''
  );
  text = text.replace(/\b(This suggests|This indicates|This means)\s+.*?\.\s*/gi, '');

  // Remove meta-commentary about capabilities
  text = text.replace(
    /I'm (using|calling|invoking)\s+.*?\s+(capability|tool|function)\s*\.?\s*/gi,
    ''
  );
  text = text.replace(
    /The\s+.*?\s+(capability|tool|function)\s+(will|should|can)\s+.*?\.\s*/gi,
    ''
  );

  // Remove status indicators that leaked through
  text = text.replace(/^(Working on|Processing|Analyzing)\s+.*?\.\s*/gim, '');
  text = text.replace(/^(Status:|Progress:|Update:)\s+.*?\.\s*/gim, '');

  // Remove function call descriptions
  text = text.replace(/^I'll use the \w+ (tool|function) to\s+.*?\.\s*/gim, '');
  text = text.replace(/^Using the \w+ (tool|function)\s+.*?\.\s*/gim, '');

  // Clean up multiple line breaks and extra whitespace
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.replace(/^\s+|\s+$/gm, ''); // Trim each line
  text = text.trim();

  return text;
}

/**
 * Determine if content warrants a thread
 */
function shouldCreateThread(content: string): boolean {
  // Create threads for:
  return (
    content.length > 200 || // Long requests
    (content.includes('explain') && content.length > 100) || // Explanations
    (content.includes('help me with') && content.length > 80) || // Help requests
    (content.includes('how do I') && content.length > 60) || // How-to questions
    content.includes('walk me through') || // Step-by-step requests
    content.includes('tutorial') || // Tutorial requests
    content.includes('step by step') || // Detailed instructions
    content.split('?').length > 2 // Multiple questions
  );
}

/**
 * Generate a friendly thread name from content
 */
function generateThreadName(content: string): string {
  // Extract key phrases for thread naming
  const truncated = content.slice(0, 80);

  // Common patterns for better naming
  if (content.includes('explain')) {
    const match = content.match(/explain\s+([^?.,]+)/i);
    if (match) return `Explaining ${match[1].trim()}`;
  }

  if (content.includes('help me with')) {
    const match = content.match(/help me with\s+([^?.,]+)/i);
    if (match) return `Help with ${match[1].trim()}`;
  }

  if (content.includes('how do I') || content.includes('how to')) {
    const match = content.match(/how (?:do I|to)\s+([^?.,]+)/i);
    if (match) return `How to ${match[1].trim()}`;
  }

  // Fallback: first meaningful phrase
  const words = truncated.split(' ').slice(0, 8);
  return words.join(' ') + (content.length > 80 ? '...' : '');
}

/**
 * Create rich Discord embed for status updates
 */
function createStatusEmbed(
  status: string,
  jobId: string,
  startTime: number,
  streamedChunks: number = 0
) {
  const duration = Date.now() - startTime;
  const statusColors: Record<string, number> = {
    pending: 0xffa500, // Orange
    processing: 0x3498db, // Blue
    completed: 0x2ecc71, // Green
    error: 0xe74c3c, // Red
  };

  const statusEmojis: Record<string, string> = {
    pending: '⏸️',
    processing: '⚡',
    completed: '✅',
    error: '❌',
  };

  return {
    color: statusColors[status] || statusColors.pending,
    title: `${statusEmojis[status] || '🤖'} Coach Artie Status`,
    fields: [
      {
        name: 'Status',
        value: status.charAt(0).toUpperCase() + status.slice(1),
        inline: true,
      },
      {
        name: 'Duration',
        value: `${Math.round(duration / 1000)}s`,
        inline: true,
      },
      {
        name: 'Job ID',
        value: `\`${jobId.slice(-8)}\``,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: streamedChunks > 0 ? `${streamedChunks} chunks streamed` : 'Processing your request...',
    },
  };
}

/**
 * Process any user intent through the unified pipeline
 */
export async function processUserIntent(
  intent: UserIntent,
  options: ProcessorOptions = {}
): Promise<void> {
  const {
    enableStreaming = true, // Default to streaming for better UX
    enableTyping = true, // Default to typing indicators
    enableReactions = false, // MINIMAL: No emoji spam
    enableEditing = true, // DEFAULT TO EDITING to prevent spam
    enableThreading = false, // MINIMAL: Less auto-organization
    maxAttempts = 60,
    statusUpdateInterval = 5,
  } = options;

  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);
  const startTime = Date.now();

  // Track processing state
  let jobCompleted = false;
  let typingInterval: NodeJS.Timeout | null = null;
  let lastStatus = 'pending';
  let updateCount = 0;
  let streamedChunks = 0;
  let lastSentContent = '';
  let streamingMessage: any = null; // For edit-based streaming
  let lastUpdateTime = 0; // Track time between edits to prevent spam
  let lastEmoji: string | null = null; // Track dynamic emoji reactions

  try {
    logger.info(`Processing user intent [${shortId}]:`, {
      correlationId,
      source: intent.source,
      userId: intent.userId,
      username: intent.username,
      contentLength: intent.content.length,
      enableStreaming,
      enableTyping,
    });

    telemetry.logEvent(
      'intent_started',
      {
        source: intent.source,
        contentLength: intent.content.length,
        enableStreaming,
        enableTyping,
      },
      correlationId,
      intent.userId
    );

    // MINIMAL: No acknowledgment emoji - just start typing like a human

    // Start typing indicator if enabled
    if (enableTyping && intent.sendTyping) {
      await intent.sendTyping();
      typingInterval = setInterval(async () => {
        try {
          await intent.sendTyping?.();
        } catch (error) {
          logger.warn(`Typing indicator failed [${shortId}]:`, error);
        }
      }, 8000);
    }

    // ENHANCED: Auto-threading for complex conversations
    if (enableThreading && intent.createThread && shouldCreateThread(intent.content)) {
      try {
        const threadName = generateThreadName(intent.content);
        const thread = await intent.createThread(threadName);
        if (thread) {
          logger.info(`Created thread "${threadName}" [${shortId}]`);
          telemetry.logEvent('thread_created', { threadName }, correlationId, intent.userId);
        }
      } catch (error) {
        logger.warn(`Failed to create thread [${shortId}]:`, error);
      }
    }

    // ENHANCED: Prepare for edit-based streaming (message created on first content)
    // We'll create the message when we have actual content to show, not before
    if (enableEditing && enableStreaming) {
      logger.info(`Edit-based streaming enabled [${shortId}]`);
      // Message will be created on first streaming update
    }

    // Submit job to capability system with Discord context
    const jobInfo = await capabilitiesClient.submitJob(
      intent.content,
      intent.userId,
      intent.context
    );
    const jobShortId = jobInfo.messageId.slice(-8);

    logger.info(`Job submitted [${shortId}]:`, {
      correlationId,
      jobId: jobInfo.messageId,
      source: intent.source,
    });

    telemetry.incrementJobsSubmitted(intent.userId, jobInfo.messageId);

    // Monitor job with unified progress handling
    jobMonitor.monitorJob(jobInfo.messageId, {
      maxAttempts,

      // Progress updates
      onProgress: async (status) => {
        try {
          // ENHANCED: Smart streaming with better formatting
          if (
            enableStreaming &&
            status.partialResponse &&
            status.partialResponse !== lastSentContent
          ) {
            // Clean capability tags before streaming
            const cleanedResponse = cleanCapabilityTags(status.partialResponse);
            const newContent = cleanedResponse.slice(lastSentContent.length);

            if (newContent.trim()) {
              // HUMAN-LIKE: Update on natural breaks, like hitting enter
              const endsWithNewline = newContent.endsWith('\n');
              const hasDoubleLine = newContent.includes('\n\n');
              const timeSinceLastUpdate = Date.now() - (lastUpdateTime || startTime);
              const minTimeBetweenUpdates = 500; // Half second minimum to prevent flicker

              // Natural update points - like a human would send
              const shouldStream =
                (endsWithNewline && timeSinceLastUpdate > minTimeBetweenUpdates) || // Natural line break
                hasDoubleLine || // Paragraph break
                newContent.length > 150 || // Getting long, send it
                timeSinceLastUpdate > 1500 || // 1.5s pause = send
                /[.!?]\s*\n/.test(newContent); // Sentence ending with newline

              if (shouldStream) {
                // HUMAN-LIKE: Stop typing as soon as we start responding
                if (typingInterval && streamedChunks === 0) {
                  clearInterval(typingInterval);
                  typingInterval = null;
                  logger.info(`Stopped typing indicator [${shortId}]`);
                }

                // Create initial message if needed
                if (!streamingMessage && enableEditing) {
                  try {
                    streamingMessage = await intent.respond(cleanedResponse);
                    lastSentContent = cleanedResponse;
                    lastUpdateTime = Date.now();
                    streamedChunks = 1;
                    logger.info(`Created initial streaming message [${shortId}]`);
                  } catch (error) {
                    logger.warn(`Failed to create streaming message [${shortId}]:`, error);
                  }
                } else if (enableEditing && intent.editResponse && streamingMessage) {
                  // Edit existing message
                  try {
                    await intent.editResponse(cleanedResponse);
                    lastSentContent = cleanedResponse;
                    lastUpdateTime = Date.now();
                    streamedChunks++;
                    logger.info(
                      `Edited streaming message [${shortId}]: ${cleanedResponse.length} chars`
                    );
                  } catch (error) {
                    // NO FALLBACK - just log and continue accumulating
                    logger.warn(`Failed to edit, will retry next batch [${shortId}]:`, error);
                  }
                } else if (!enableEditing && streamedChunks === 0) {
                  // Non-edit mode: single initial message only
                  await intent.respond(cleanedResponse);
                  lastSentContent = cleanedResponse;
                  streamedChunks = 1;
                  logger.info(`Sent initial response [${shortId}]`);
                }
              }
            }
          }

          // MINIMAL: No emoji reactions - just pure human-like behavior
          lastStatus = status.status;
          updateCount++;
        } catch (error) {
          logger.warn(`Progress update failed [${shortId}]:`, error);
        }
      },

      // Job completion
      onComplete: async (result) => {
        if (jobCompleted) {
          logger.warn(`Duplicate completion blocked [${shortId}]`);
          return;
        }
        jobCompleted = true;

        const duration = Date.now() - startTime;

        // Stop typing indicator
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }

        logger.info(`Job completed [${shortId}]:`, {
          correlationId,
          jobId: jobInfo.messageId,
          duration: `${duration}ms`,
          resultLength: result?.length || 0,
          streamedChunks,
        });

        // MINIMAL: Just clean up any working emojis, no completion spam
        if (enableReactions && intent.removeReaction) {
          try {
            if (lastEmoji) await intent.removeReaction(lastEmoji);
            // No checkmark - response speaks for itself
          } catch (error) {
            // Silent cleanup
          }
        }

        try {
          // Clean the response of capability tags
          const cleanResult = cleanCapabilityTags(result || 'No response received');

          // ENHANCED: Handle final response with edit-based streaming
          if (enableEditing && streamingMessage && lastSentContent) {
            // For edit-based streaming, ensure final content is properly set
            const trimmedResult = cleanResult.trim();
            const trimmedSent = lastSentContent.trim();

            if (trimmedResult !== trimmedSent && trimmedResult.length > trimmedSent.length) {
              try {
                if (intent.editResponse) {
                  await intent.editResponse(cleanResult);
                  logger.info(`Final edit completed [${shortId}]: ${cleanResult.length} chars`);
                }
              } catch (error) {
                logger.warn(`Failed final edit [${shortId}]:`, error);
              }
            } else {
              logger.info(`No final edit needed [${shortId}] (content complete)`);
            }
          } else if (streamedChunks === 0) {
            // No streaming happened, send complete response
            await intent.respond(cleanResult);
            logger.info(`Sent final response [${shortId}] (no streaming)`);
          } else {
            // Traditional streaming - check for additional content
            const trimmedResult = cleanResult.trim();
            const trimmedSent = lastSentContent.trim();

            if (trimmedResult.length > trimmedSent.length + 20) {
              const additionalContent = trimmedResult.slice(trimmedSent.length).trim();
              if (additionalContent && !additionalContent.startsWith(trimmedSent.slice(-10))) {
                await intent.respond(additionalContent);
                logger.info(
                  `Sent additional final content [${shortId}]: ${additionalContent.slice(0, 50)}...`
                );
              } else {
                logger.info(`Skipped final response [${shortId}] (redundant with stream)`);
              }
            } else {
              logger.info(`Skipped final response [${shortId}] (already fully streamed)`);
            }
          }

          telemetry.logEvent(
            'intent_completed',
            {
              source: intent.source,
              jobId: jobInfo.messageId,
              duration,
              streamedChunks,
              resultLength: result?.length || 0,
            },
            correlationId,
            intent.userId,
            duration,
            true
          );
        } catch (error) {
          logger.error(`Failed to send completion response [${shortId}]:`, error);
        }
      },

      // Error handling
      onError: async (error) => {
        const duration = Date.now() - startTime;

        // Stop typing indicator
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }

        logger.error(`Job failed [${shortId}]:`, {
          correlationId,
          jobId: jobInfo.messageId,
          error,
          duration: `${duration}ms`,
        });

        // MINIMAL: Just clean up any working emojis on error
        if (enableReactions && intent.removeReaction && lastEmoji) {
          try {
            await intent.removeReaction(lastEmoji);
          } catch (error) {
            // Silent cleanup
          }
        }

        try {
          // ENHANCED: User-friendly error messages while staying transparent
          const userFriendlyError =
            typeof error === 'string' && error.length < 100
              ? `Something went wrong: ${error}`
              : 'Something went wrong processing your request. The issue has been logged.';

          await intent.respond(`❌ ${userFriendlyError}`);

          telemetry.logEvent(
            'intent_failed',
            {
              source: intent.source,
              jobId: jobInfo.messageId,
              error,
              duration,
            },
            correlationId,
            intent.userId,
            duration,
            false
          );
        } catch (replyError) {
          logger.error(`Failed to send error response [${shortId}]:`, replyError);
        }
      },
    });

    logger.info(`Intent processing setup complete [${shortId}]`);
  } catch (error) {
    // Cleanup on setup failure
    if (typingInterval) {
      clearInterval(typingInterval);
    }

    logger.error(`Intent processing setup failed [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      source: intent.source,
    });

    telemetry.logEvent(
      'intent_setup_failed',
      {
        source: intent.source,
        error: error instanceof Error ? error.message : String(error),
      },
      correlationId,
      intent.userId
    );

    try {
      await intent.respond(
        `Failed to process your ${intent.source}: ${error instanceof Error ? error.message : String(error)}`
      );
    } catch (replyError) {
      logger.error(`Failed to send setup error response [${shortId}]:`, replyError);
    }
  }
}

/**
 * run-turn.ts: the engine's spine for one incoming message.
 *
 *   processMessage → fast paths (fast-paths.ts) → runTurn:
 *     trace → email short-circuit → native tool loop (default; runNativeTurn)
 *     → after-turn effects (auto-sing)
 *
 * Wave 6 merged the old process-message handler and capability-orchestrator.ts into this
 * file. The voice-note TTS fast path and the periodic credit_status check live in
 * fast-paths.ts.
 */
import { IncomingMessage } from '../../shared/queue/types.js';
import { logger } from '../../shared/logger.js';
import { mintTrusted } from '../../shared/trusted-ids.js';
import { openRouterService } from '../4-generate/openrouter.js';
import { capabilityRegistry } from '../5-tool-loop/registry.js';
import { costMonitor } from '../budget/usage-ledger.js';
import { updateUserScoresFromMessage } from './user-scores.js';
import { tryVoiceNoteFastPath, maybeAutoCheckCredits } from './fast-paths.js';
import { getErrorMessage, getErrorStack } from '../../shared/errors.js';
import { emailDraftingService } from '../tools/people/email-drafting.js';
import { llmResponseCoordinator } from '../4-generate/generate-reply.js';
import { capabilityBootstrap } from '../5-tool-loop/register-tools.js';
import { executeNativeToolCall } from '../5-tool-loop/execute.js';
import { JOB_TIMEOUT_MS, SOFT_DEADLINE_RESERVE_MS } from '../5-tool-loop/timeouts.js';
import { traceManager } from './trace.js';
import { sessionManager } from './session-log.js';
import { OrchestrationContext } from './types.js';

/**
 * Format a tool execution result status.
 */
function formatResultStatus(success: boolean): string {
  if (success) {
    return 'OK';
  }
  return 'FAIL';
}

export async function processMessage(
  message: IncomingMessage,
  onPartialResponse?: (partial: string) => void
): Promise<string> {
  try {
    // Increment message counter for cost monitoring
    costMonitor.incrementMessageCount();
    const messageCount = costMonitor.getMessageCount();

    // Check if OpenRouter is configured
    if (
      !process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY === 'sk-or-your-openrouter-key-here'
    ) {
      // Fallback to echo response if no API key
      const response = `Hello! I received your message: "${message.message}" (OpenRouter not configured - add your API key to enable AI responses)`;
      logger.info(`Processed message from user ${message.userId} (echo mode)`);
      return response;
    }

    // Check if capabilities should be enabled
    const enableCapabilities = process.env.ENABLE_CAPABILITIES !== 'false';

    if (enableCapabilities) {
      logger.info(`🎬 Processing message with capability orchestration: ${message.id}`);

      // Ongoing per-user "vibe" scores — fire-and-forget on the cheap background model.
      // Fired BEFORE orchestration (not after) so it scores the incoming message even when
      // the response times out — otherwise a spammer's worst messages (which are exactly the
      // ones that hit the 120s timeout) never get scored and their profile stays stale.
      try {
        const guildId = (message.context as { guildId?: string } | undefined)?.guildId || '';
        void updateUserScoresFromMessage(message.userId, guildId, message.message);
      } catch {
        // scoring must never affect the actual response
      }

      // Voice-note fast path (fast-paths.ts): a plain voice-note ask runs tts directly.
      const voiceNoteAck = await tryVoiceNoteFastPath(message);
      if (voiceNoteAck !== null) {
        return voiceNoteAck;
      }

      // Use capability orchestrator for full pipeline with streaming support
      const orchestratedResponse = await capabilityOrchestrator.orchestrateMessage(
        message,
        onPartialResponse
      );

      // Periodic direct credit_status check (fast-paths.ts)
      await maybeAutoCheckCredits(messageCount);

      logger.info(`✅ Capability orchestration completed for user ${message.userId}`);
      return orchestratedResponse;
    } else {
      logger.info(`🤖 Processing message with simple AI chat: ${message.id}`);

      // Fallback to Context Alchemy-powered AI response
      const { contextAlchemy } = await import('../3-context/assemble.js');
      const { promptManager } = await import('../3-context/system-prompt.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(message.message);
      let discordContext: Record<string, any> | undefined;
      if (message.context?.platform === 'discord' || message.context?.guildKnowledge) {
        discordContext = message.context;
      }

      const { messages } = await contextAlchemy.buildMessageChain(
        message.message,
        message.userId,
        baseSystemPrompt,
        message.context?.conversationHistory || [],
        {
          source: message.source,
          // Pass full Discord context for guild knowledge, proactive answering, etc.
          // Discord uses source: 'message', check for platform or guildKnowledge in context
          discordContext,
        }
      );

      // Use streaming if callback provided, otherwise regular generation
      let aiResponse: string;
      if (onPartialResponse) {
        aiResponse = await openRouterService.generateFromMessageChainStreaming(
          messages,
          message.userId,
          onPartialResponse,
          message.id
        );
      } else {
        aiResponse = await openRouterService.generateFromMessageChain(messages, message.userId, message.id);
      }

      logger.info(`Generated simple AI response for user ${message.userId}`);
      return aiResponse;
    }
  } catch (error) {
    // Full detail goes to the log only. This reply used to post the stack, server paths,
    // raw error text and the whole tool list into whatever channel asked (fixed 2026-10-23).
    logger.error(
      `Error processing message ${message.id} from ${message.userId} (${message.source}):`,
      error
    );
    return "Something broke on my end and I couldn't finish that. Try again in a minute.";
  }
}

export class CapabilityOrchestrator {
  private contexts = new Map<string, OrchestrationContext>();

  constructor() {
    // Initialize the capability registry with all capabilities
    capabilityBootstrap.initializeCapabilityRegistry();
  }

  /**
   * Main entry point for one turn.
   * Takes an incoming message and runs the full capability pipeline
   */
  async orchestrateMessage(
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    const startTime = Date.now();
    logger.info('🎯 ORCHESTRATOR START - This should always appear');
    logger.info(
      '🔥 ORCHESTRATOR ENTRY - About to create context and call assembleMessageOrchestration'
    );

    // Track user session for engagement analytics
    await sessionManager.trackActivity(message.userId, message.context?.guildId);

    // Context Alchemy: Create trace at the start of orchestration
    const traceId = await traceManager.createTrace({
      messageId: message.id,
      userId: message.userId,
      guildId: message.context?.guildId,
      channelId: message.context?.channelId,
    });

    // Capture input text for debugging
    if (traceId) {
      await traceManager.updateTrace(traceId, {
        inputText: message.message,
      });
    }

    // Check if user has an active draft and is responding to it
    const activeDraft = emailDraftingService.getDraft(message.userId);
    if (activeDraft && activeDraft.status === 'draft') {
      const draftResponse = emailDraftingService.detectDraftResponse(message.message);
      if (draftResponse) {
        logger.info(`📧 DRAFT RESPONSE DETECTED: ${draftResponse.action}`);
        const result = await emailDraftingService.handleDraftResponse(
          message,
          activeDraft,
          draftResponse,
          onPartialResponse
        );
        // Update trace for draft handling
        await traceManager.updateTrace(traceId, {
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          responseLength: result.length,
          responseText: result,
          inputText: message.message,
          success: true,
        });
        return result;
      }
    }

    // Check if this is an email request
    const emailIntent = await emailDraftingService.detectEmailIntent(
      message.message,
      message.userId
    );
    if (emailIntent) {
      logger.info('📧 EMAIL INTENT DETECTED - Routing to email writing mode');
      const result = await emailDraftingService.handleEmailWritingMode(
        message,
        emailIntent,
        onPartialResponse
      );
      // Update trace for email handling
      await traceManager.updateTrace(traceId, {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        responseLength: result.length,
        responseText: result,
        inputText: message.message,
        success: true,
      });
      return result;
    }

    const context = this.createOrchestrationContext(message, traceId);
    this.contexts.set(message.id, context);

    // Context Alchemy: Inject traceId into message context for downstream services
    const messageWithTrace = {
      ...message,
      context: {
        ...message.context,
        traceId,
      },
    };

    try {
      logger.info(`🎬 Starting orchestration for message ${message.id}`);
      logger.info(`🔥 ABOUT TO CALL assembleMessageOrchestration for ${message.id}`);
      const result = await this.assembleMessageOrchestration(
        context,
        messageWithTrace,
        onPartialResponse
      );
      logger.info(`🔥 assembleMessageOrchestration COMPLETED for ${message.id}`);

      // Context Alchemy: Update trace on successful completion
      await traceManager.updateTrace(traceId, {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        responseLength: result.length,
        responseText: result, // Capture full response for debugging bad responses
        success: true,
      });

      // MECHANICAL GUARANTEE: lyric sheets get sung. Prompt rules kept lapsing
      // (~1 in 5 song requests shipped as text) — if the reply looks like a lyric
      // sheet and no tts ran this job, the house band kicks in automatically.
      this.autoSingLyricSheet(context, result);

      return result;
    } catch (error) {
      logger.error(`❌ Orchestration failed for message ${message.id}:`, error);
      this.contexts.delete(message.id);

      // Context Alchemy: Update trace on failure
      await traceManager.updateTrace(traceId, {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        success: false,
        errorType: getErrorMessage(error),
      });

      return this.generateOrchestrationFailureResponse(error, context, message);
    }
  }

  /**
   * The turn pipeline: one runToolLoop over native tool calls.
   */
  private async assembleMessageOrchestration(
    context: OrchestrationContext,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    return this.runNativeTurn(context, message, onPartialResponse);
  }

  /**
   * Native tool turn (wave 8): generate with tools → run the calls (parallel, with the taint
   * guard) → repeat until the model answers without calls, the round cap (timeouts.ts, 8) or
   * the turn's soft deadline. Generate errors propagate to orchestrateMessage's failure reply.
   */
  private async runNativeTurn(
    context: OrchestrationContext,
    message: IncomingMessage,
    onPartialResponse?: (partial: string) => void
  ): Promise<string> {
    logger.info(`🔧 Native tool turn for <${message.userId}> message ${message.id}`);
    const finalText = await llmResponseCoordinator.getNativeToolResponse(message, {
      executeTool: (invocation) => executeNativeToolCall(context, invocation),
      deadlineAt: context.deadlineAt,
      onStep: (step) => {
        // Text that rides along with tool calls ("one sec, checking") streams as it comes;
        // the final answer is sent once, below.
        if (step.toolCalls > 0 && step.content.trim() && onPartialResponse) {
          onPartialResponse(
            llmResponseCoordinator.stripThinkingTags(step.content, message.userId, message.id)
          );
        }
      },
    });

    if (onPartialResponse && finalText) {
      onPartialResponse(finalText);
    }
    this.contexts.delete(message.id);
    return finalText;
  }

  /**
   * Create the per-turn orchestration context
   */
  private createOrchestrationContext(
    message: IncomingMessage,
    traceId?: string | null
  ): OrchestrationContext {
    const context: OrchestrationContext = {
      messageId: message.id,
      userId: message.userId,
      originalMessage: message.message,
      source: message.source,
      capabilities: [],
      results: [],
      currentStep: 0,
      respondTo: message.respondTo,
      capabilityFailureCount: new Map(), // Circuit breaker
      discord_context: message.context, // Pass through Discord context for mention resolution
      traceId, // Context Alchemy: Link to generation trace
      // Stamp the deadline as early as possible: it has to cover the work that happens
      // BEFORE the loop too, since that's exactly the time the loop used to ignore.
      // SOFT_DEADLINE_RESERVE_MS leaves room to actually send the answer we salvage.
      deadlineAt: Date.now() + JOB_TIMEOUT_MS - SOFT_DEADLINE_RESERVE_MS,
    };
    // Security audit 2026-10-26 (sec-abuse.md, batch 2): resolveDiscordMessageLinks
    // (gateway/1-receive/expand-links.ts) pulls another user's past message text straight
    // into this turn's context BEFORE the tool loop starts — attacker-controlled content
    // that never passes through a capability call, so it could never set
    // taintedByExternalContent on its own. Taint at ingest, same as a web/http fetch would.
    const resolvedLinks = message.context?.resolvedDiscordMessages;
    if (Array.isArray(resolvedLinks) && resolvedLinks.length > 0) {
      context.taintedByExternalContent = true;
      context.taintSource = 'discord-link-expansion';
      logger.warn(
        `🛡️ TAINT SET: context tainted by discord-link-expansion (${resolvedLinks.length} linked message(s))`
      );
    }
    return context;
  }

  /**
   * If the final visible reply is a lyric sheet ([Chorus]/[Verse] labels, or 🎶 with a
   * stack of short lines) and no tts capability executed during this job, sing it —
   * fire-and-forget so the text reply isn't delayed by music generation. The channel
   * gets the lyric sheet AND, ~a minute later, the actual jam.
   */
  private autoSingLyricSheet(context: OrchestrationContext, response: string): void {
    try {
      const channelId = context.discord_context?.channelId;
      if (!channelId || !response || response.length < 120) return;
      if (context.results?.some((r) => r.capability?.name === 'tts')) return;
      const hasSectionLabel = /[[(*]\s*(chorus|verse\s*\d?|bridge|hook|outro)\b/i.test(response);
      const shortLines = response
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 8 && l.length < 80 && !l.startsWith('http'));
      // Musical intent signal: 🎵/🎶 markers wrapping bars. A formatted lyric sheet has
      // 8+ short lines; a loose freestyle (Artie raps a 4-line verse then trails into prose)
      // has fewer lines but multiple notes — catch both so freestyles don't ship as text.
      const musicNotes = (response.match(/🎶|🎵/g) || []).length;
      const looksLyrical =
        hasSectionLabel ||
        (/🎶|🎵/.test(response) && shortLines.length >= 8) ||
        (musicNotes >= 2 && shortLines.length >= 4);
      if (!looksLyrical) return;
      const lyrics = response
        .replace(/\*\*/g, '')
        .replace(/^#+\s*/gm, '')
        .trim();
      logger.warn('🎼 Lyric sheet shipped with no tts call — auto-singing it (mechanical guarantee)');
      void capabilityRegistry
        .execute(
          'tts',
          'sing',
          { lyrics },
          undefined,
          mintTrusted(
            {
              userId: context.userId,
              messageId: context.messageId,
              channelId,
              guildId: context.discord_context?.guildId,
            },
            'discord-turn'
          )
        )
        .catch((e) => logger.warn('Auto-sing failed:', e));
    } catch (e) {
      logger.warn('Auto-sing detection failed:', e);
    }
  }

  /**
   * Turn a failed turn into the reply (usually silence), logging the full context
   */
  private generateOrchestrationFailureResponse(
    error: unknown,
    context: OrchestrationContext,
    message: IncomingMessage
  ): string {
    const errorMessage = getErrorMessage(error);

    // IMPORTANT: whatever this returns is posted verbatim into the channel that triggered
    // the failure — which may be public or a *client-facing* channel. Never leak billing,
    // auth, or internal debug detail to users. Log the real diagnostics server-side and
    // either stay silent (return '') or reply with a short, internals-free human line.
    // (An empty response is treated as "nothing to say" and is not posted.)

    // Billing / credit exhaustion / kill switch (incl. the daily budget mute) — operator
    // concern only. Stay silent in the channel.
    if (
      errorMessage.includes('GENERATION MUTED') ||
      errorMessage.includes('OUT OF CREDITS') ||
      errorMessage.includes('credit') ||
      errorMessage.includes('402')
    ) {
      logger.error(
        `🔇 Credits/billing failure suppressed from channel (source=${message.source}, ` +
          `msg=${message.id}, user=${message.userId}): ${errorMessage}`
      );
      return '';
    }

    // Auth / API-key problems — also operator-only. Stay silent in the channel.
    if (
      errorMessage.includes('AUTH ERROR') ||
      errorMessage.includes('401') ||
      errorMessage.includes('403')
    ) {
      logger.error(
        `🔇 Auth failure suppressed from channel (source=${message.source}, ` +
          `msg=${message.id}, user=${message.userId}): ${errorMessage}`
      );
      return '';
    }

    // Transient, user-retryable conditions — a short, friendly line is fine (no internals).
    if (errorMessage.includes('RATE LIMITED') || errorMessage.includes('429')) {
      return `⏱️ One sec — I'm getting a lot of requests right now. Try me again in a moment.`;
    }
    // A 400 that survived the whole model fallback chain is the provider rejecting the
    // request, not a user error. Worth a word: silence here reads as being ignored, and
    // that is exactly how these went unnoticed in the channel for weeks.
    if (errorMessage.includes('400')) {
      return `🔧 The model provider bounced that one — try me again in a moment.`;
    }
    if (errorMessage.includes('SERVER ERROR') || errorMessage.includes('50')) {
      return `🔧 I'm having a brief hiccup — give it a few minutes and try again.`;
    }

    // Anything else: keep the full diagnostic detail in the logs, say nothing publicly.
    const resultsStr = context.results.map((r) => `${r.capability.name}:${formatResultStatus(r.success)}`).join(', ');
    logger.error(
      `🚨 Orchestration failure (suppressed from channel) for message ${message.id}\n` +
        `  user=${message.userId} source=${message.source} msg="${message.message}"\n` +
        `  error=${errorMessage}\n` +
        `  capabilities=[${context.capabilities.map((c) => `${c.name}:${c.action}`).join(', ')}]\n` +
        `  results=[${resultsStr}]\n` +
        `  step=${context.currentStep} registry=${capabilityRegistry.getStats().totalCapabilities}cap/${capabilityRegistry.getStats().totalActions}act\n` +
        `  stack=${getErrorStack(error)}`
    );
    return '';
  }

  /**
   * Get orchestration context for a message (for debugging)
   */
  getContext(messageId: string): OrchestrationContext | undefined {
    return this.contexts.get(messageId);
  }

  /**
   * List active orchestrations (for monitoring)
   */
  getActiveOrchestrations(): string[] {
    return Array.from(this.contexts.keys());
  }
}

// Export singleton instance. Constructing it at module load is what registers every
// capability (capabilityBootstrap.initializeCapabilityRegistry), which is why main.ts
// imports this module for its side effect.
export const capabilityOrchestrator = new CapabilityOrchestrator();

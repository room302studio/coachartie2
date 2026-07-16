import { IncomingMessage, logger } from '@coachartie/shared';
import { openRouterService } from '../services/llm/openrouter.js';
import { capabilityOrchestrator } from '../services/capability/capability-orchestrator.js';
import { capabilityRegistry } from '../services/capability/capability-registry.js';
import { costMonitor } from '../services/monitoring/cost-monitor.js';
import { updateUserScoresFromMessage } from '../services/user-scores.js';

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

      // VOICE-NOTE FAST PATH: a budget model (brownout Haiku) rationalizes its way
      // out of calling the tts capability ("I don't have the channel ID") no matter
      // how the prompt is worded. When someone plainly asks for a voice note, just
      // DO it — we hold the real channelId here, so there's nothing to reason about.
      const voiceNote = detectVoiceNoteRequest(message);
      if (voiceNote) {
        const channelId = (message.context as { channelId?: string } | undefined)?.channelId;
        const guildId = (message.context as { guildId?: string } | undefined)?.guildId;
        if (channelId) {
          logger.info(`🎙️ Voice-note fast path (${voiceNote.action}) for message ${message.id}`);
          try {
            const result = await capabilityRegistry.execute('tts', voiceNote.action, {
              channelId,
              guildId,
              userId: message.userId,
              ...(voiceNote.text ? { text: voiceNote.text } : {}),
              ...(voiceNote.voice ? { voice: voiceNote.voice } : {}),
            });
            logger.info(`🎙️ Voice-note fast path result: ${result.slice(0, 120)}`);
            // The audio IS the reply. Short text ack, no [SILENT] (that would delete nothing).
            return voiceNote.action === 'vibe_report'
              ? '🎙️ dropping a vibe report.'
              : '🎙️ on it.';
          } catch (err) {
            logger.warn(`🎙️ Voice-note fast path failed, falling back to orchestration:`, err);
            // fall through to normal orchestration
          }
        }
      }

      // Use capability orchestrator for full pipeline with streaming support
      const orchestratedResponse = await capabilityOrchestrator.orchestrateMessage(
        message,
        onPartialResponse
      );

      // Check if we should auto-check credits
      const autoCheckEvery = parseInt(process.env.AUTO_CHECK_CREDITS_EVERY || '50');
      if (autoCheckEvery > 0 && messageCount % autoCheckEvery === 0) {
        logger.info(`📊 Auto-checking credits (message ${messageCount}/${autoCheckEvery})`);

        try {
          const { capabilityRegistry } = await import(
            '../services/capability/capability-registry.js'
          );
          const creditStatus = await capabilityRegistry.execute(
            'credit_status',
            'check_balance',
            {}
          );
          logger.info(`💰 Auto Credit Check:\n${creditStatus}`);

          // Parse and check for critical alerts
          try {
            const statusData = JSON.parse(creditStatus);
            if (statusData.data?.active_alerts > 0) {
              logger.warn(`🚨 ${statusData.data.active_alerts} active credit alerts detected!`);
            }
          } catch (_e) {
            // Ignore parse errors
          }
        } catch (error) {
          logger.error('Failed to auto-check credits:', error);
        }
      }

      logger.info(`✅ Capability orchestration completed for user ${message.userId}`);
      return orchestratedResponse;
    } else {
      logger.info(`🤖 Processing message with simple AI chat: ${message.id}`);

      // Fallback to Context Alchemy-powered AI response
      const { contextAlchemy } = await import('../services/llm/context-alchemy.js');
      const { promptManager } = await import('../services/llm/prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(message.message);
      const { messages } = await contextAlchemy.buildMessageChain(
        message.message,
        message.userId,
        baseSystemPrompt,
        message.context?.conversationHistory || [],
        {
          source: message.source,
          // Pass full Discord context for guild knowledge, proactive answering, etc.
          // Discord uses source: 'message', check for platform or guildKnowledge in context
          discordContext:
            message.context?.platform === 'discord' || message.context?.guildKnowledge
              ? message.context
              : undefined,
        }
      );

      // Use streaming if callback provided, otherwise regular generation
      const aiResponse = onPartialResponse
        ? await openRouterService.generateFromMessageChainStreaming(
            messages,
            message.userId,
            onPartialResponse,
            message.id
          )
        : await openRouterService.generateFromMessageChain(messages, message.userId, message.id);

      logger.info(`Generated simple AI response for user ${message.userId}`);
      return aiResponse;
    }
  } catch (error) {
    logger.error('Error processing message:', error);
    return `🚨 VERBOSE ERROR DEBUG INFO 🚨
Message ID: ${message.id}
User ID: ${message.userId}
Source: ${message.source}
Original Message: "${message.message}"
Error: ${error instanceof Error ? error.message : String(error)}
Stack: ${error instanceof Error ? error.stack : 'No stack trace'}
Timestamp: ${new Date().toISOString()}
OpenRouter Key Status: ${process.env.OPENROUTER_API_KEY ? 'CONFIGURED' : 'MISSING'}
Capabilities Enabled: ${process.env.ENABLE_CAPABILITIES !== 'false'}
Environment: ${process.env.NODE_ENV || 'unknown'}
Available Capabilities: ${capabilityRegistry
      .list()
      .map((c: { name: string }) => c.name)
      .join(', ')}`;
  }
}

/**
 * Detect an explicit request for a voice note / vibe report, so the fast path can
 * honor it deterministically instead of relying on a budget model to call the tool.
 * Deliberately tight — only fires on a clear ask, not any mention of "voice".
 */
function detectVoiceNoteRequest(
  message: IncomingMessage
): { action: 'vibe_report' | 'speak'; text?: string; voice?: string } | null {
  const raw = (message.message || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  // Must read as a request (asking/telling), not just a topic mention.
  const asky = /\b(make|do|give|drop|send|record|cut|can you|could you|would you|please|lets|let'?s|gimme|gib|i want|we want|need)\b/.test(t);

  const vibeReport = /\bvibe\s?report\b|\bvibe\s?check\b|\bradio\s?(bit|report|show|hour)\b|\bnews\s?(bit|report|bulletin|broadcast)\b|\bthe\s?tapes?\b/.test(t);
  const genericVoiceNote = /\bvoice\s?(note|memo|message|report)\b|\bsay it out loud\b|\bread .* (out loud|aloud)\b|\bspeak it\b|\btalk to us\b/.test(t);

  if (!(vibeReport || genericVoiceNote)) return null;
  // A bare mention with no ask verb is too weak — skip (avoid false positives like
  // "that voice note earlier was funny").
  if (!asky && !vibeReport) return null;

  // Optional voice steer, e.g. "in the anchor voice" / "as the anchor".
  const voiceMatch = t.match(/\b(?:in|as|with|using)\s+(?:the\s+)?(artie|anchor|dj|poetic|field|dispatch|robot|rookie|caller)\b(?:\s+voice)?/);
  const voice = voiceMatch?.[1];

  // "say '<text>'" / 'read this out loud: <text>' → speak the given words.
  const speakMatch =
    raw.match(/\bsay\s+["“]([^"”]{2,})["”]/i) ||
    raw.match(/\b(?:read|speak)(?: this)?(?: out loud| aloud)?:\s*(.+)$/i);
  if (speakMatch && speakMatch[1] && !vibeReport) {
    return { action: 'speak', text: speakMatch[1].trim(), voice };
  }

  return { action: 'vibe_report', voice };
}

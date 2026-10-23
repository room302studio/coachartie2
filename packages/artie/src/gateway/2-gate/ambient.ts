/**
 * Ambient: the unaddressed-message judgment (should Artie speak up on his own?), the
 * proactive and respondToAll cooldowns, and the hourly ambient-response budget. Moved
 * verbatim out of on-message.ts (wave 5).
 */

import type { Client, Message } from 'discord.js';
import { resolveModelSpec, isAutoRouted, autoReasoningFor } from '../../shared/model-spec.js';
import { estimateTokens } from '../../shared/async.js';
import { logger } from '../../shared/logger.js';
import { parseModelJson } from '../../shared/model-json.js';
import { getSyncDb } from '../../shared/db/client.js';
import { getKillSwitchPath, isGenerationMuted } from '../../shared/kill-switch.js';
import type { ChannelPersona, GuildConfig } from '../../shared/config/guilds.js';
import { telemetry } from '../telemetry.js';
import { getEnhancedGuildContext } from '../1-receive/guild-context.js';
import type { JsonOutputSpec } from '../../shared/structured-output.js';
import { trimTrailingSlash } from '../../shared/text.js';
import * as engine from '../../engine/api.js';

/** The judgment reply, sent as response_format to models that take it (wave 10). */
const JUDGMENT_OUTPUT: JsonOutputSpec = {
  name: 'proactive_judgment',
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'boolean' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['answer', 'confidence', 'reason'],
    additionalProperties: false,
  },
};

/** How the incoming message reached Artie (on-message's response-conditions step). */
export interface ResponseConditions {
  botMentioned: boolean;
  repliedToBot: boolean;
  isDM: boolean;
  isRobotChannel: boolean;
  isForumThread: boolean;
  isProactiveAnswer: boolean;
}

// Proactive answering cooldown cache (guildId -> lastProactiveAnswerTimestamp)
const proactiveCooldownCache = new Map<string, number>();

// respondToAll persona cooldown cache (channelId -> lastResponseTimestamp).
// Stops personas like Judge Artie from replying to every single message (and burning
// a full LLM call each time). Mentions still bypass this.
const RESPOND_TO_ALL_COOLDOWN_SECONDS = 45;
const channelResponseCooldownCache = new Map<string, number>();

// Ambient response budget: a hard cap on how many responses the bot sends per rolling
// hour WITHOUT being @-mentioned or DMed (proactive answers, respondToAll personas,
// robot-channel chatter). Explicit mentions/DMs are never counted or blocked. This is the
// backstop that prevents a misconfiguration or feedback loop from exhausting OpenRouter
// credits. Tune via AMBIENT_RESPONSE_HOURLY_CAP.
export const AMBIENT_RESPONSE_HOURLY_CAP = parseInt(process.env.AMBIENT_RESPONSE_HOURLY_CAP || '40', 10);
const AMBIENT_WINDOW_MS = 60 * 60 * 1000;
const ambientResponseTimestamps: number[] = [];

export function isAmbientBudgetExhausted(): boolean {
  const cutoff = Date.now() - AMBIENT_WINDOW_MS;
  while (ambientResponseTimestamps.length && ambientResponseTimestamps[0] < cutoff) {
    ambientResponseTimestamps.shift();
  }
  return ambientResponseTimestamps.length >= AMBIENT_RESPONSE_HOURLY_CAP;
}

export function recordAmbientResponse(): void {
  ambientResponseTimestamps.push(Date.now());
}

export function getAmbientResponseCount(): number {
  const cutoff = Date.now() - AMBIENT_WINDOW_MS;
  return ambientResponseTimestamps.filter((t) => t >= cutoff).length;
}

/** Stamp the respondToAll cooldown once a persona channel actually gets a reply. */
export function markRespondToAllCooldown(channelId: string): void {
  channelResponseCooldownCache.set(channelId, Date.now());
}

// EMERGENCY KILL SWITCH — global mute. If this file exists, Artie ignores ALL messages.
// `touch <repo>/KILL_SWITCH` to silence instantly (no restart); `rm` to revive.
// Toggle remotely via POST /api/killswitch {"enabled":true|false}.
// Also set automatically by the daily spend cap (capabilities daily-budget.ts).
const KILL_SWITCH_PATH = getKillSwitchPath();

/**
 * The cheap "should I speak?" model. Same fallback chain the repo uses for every cheap
 * background call (memory tagging, observation, user scores), with PROACTIVE_JUDGMENT_MODEL
 * as the specific override — no model id is introduced here.
 */
function judgmentModel(): string {
  return (
    process.env.PROACTIVE_JUDGMENT_MODEL ||
    process.env.BACKGROUND_MODEL ||
    process.env.FAST_MODEL ||
    'google/gemini-2.0-flash-001'
  );
}

// Per-1K-token rates (input, output) for the judgment row in model_usage_stats. Mirrors the
// capabilities MODEL_PRICING for the cheap models; an unknown model is booked high, not free.
const JUDGMENT_PRICING: Record<string, [number, number]> = {
  'google/gemini-2.0-flash-001': [0.0001, 0.0004],
  'google/gemini-2.0-flash': [0.0001, 0.0004],
  'google/gemini-2.5-flash': [0.0003, 0.0025],
  'openai/gpt-4o-mini': [0.00015, 0.0006],
  'anthropic/claude-haiku-4.5': [0.001, 0.005],
};
const UNKNOWN_JUDGMENT_PRICING: [number, number] = [0.005, 0.025];

/**
 * Use LLM to judge if Artie should proactively answer a question
 * Based on the guild context and message content
 */
export async function shouldProactivelyAnswer(
  message: Message,
  guildContext: string,
  correlationId: string
): Promise<boolean> {
  try {
    // Don't spend a judgment LLM call if we couldn't act on a "yes" anyway — the ambient
    // hourly budget is already exhausted.
    if (isAmbientBudgetExhausted()) {
      logger.warn('💸 Skipping proactive judgment - ambient response budget exhausted');
      return false;
    }

    // Debug: log what context we have
    logger.info(`🔍 Proactive judgment context length: ${guildContext?.length || 0} chars`);

    // Detect guild type for context-appropriate judgment
    const guildId = message.guild?.id;
    const isRoom302 = guildId === '932719842522443928';

    // Fetch user profile: what do we know about this person?
    let relationshipContext = '';
    try {
      const { ObservationalLearning } = await import('../watchers/observe-channels.js');
      const profile = ObservationalLearning.getUserProfile(message.author.id, guildId || '');
      if (profile) {
        relationshipContext = `\n${profile}\n\nUse this profile to calibrate: if this person has pushed back on unsolicited input before, set answer=false.`;
      }
    } catch {
      // Non-fatal — proceed without profile
    }

    const helpCriteria = isRoom302
      ? `Set answer=true ONLY if:
- Someone is ASKING a direct question they need help answering
- Someone describes a problem or blocker and is explicitly looking for solutions
- Someone is confused or stuck and would welcome input
- The message has substance (at least 8 words) and contains a clear question or request

Set answer=false if:
- Someone is SHARING an agenda, plan, update, or status — they're informing, not asking
- Someone is posting their own work product (designs, schedules, lists, to-do items) — don't critique unless asked
- The message is an announcement or statement, not a question
- You'd be giving unsolicited feedback on someone else's decisions or plans
- The person clearly has the situation handled and isn't asking for help
- Someone is listing items, bullet points, or action items — that's organizing, not asking

KEY TEST: Would a thoughtful coworker jump in here unprompted, or would they just nod and let the person continue? If "nod and listen" — set answer=false.

This is a small working team. You're a teammate, not a supervisor. Respond to questions and requests for help. Do NOT volunteer opinions on other people's work unless asked.`
      : `Set answer=true ONLY if:
- They're clearly asking a SPECIFIC question about the game
- They have a bug/issue AND are asking for help
- Your knowledge base EXPLICITLY covers what they're asking about
- The message is at least 10 words and contains a clear question`;

    const prompt = `You are a helper bot deciding whether to engage with a message. Be CONSERVATIVE - only answer clear help requests or questions you can genuinely help with.

YOUR KNOWLEDGE BASE:
${guildContext}
${relationshipContext}

MESSAGE FROM @${message.author.username || message.author.displayName || 'unknown'}:
"${message.content}"

Respond with JSON only:
{"answer": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}

${helpCriteria}

Set answer=false if:
- Short messages (under 6 words) - these are usually banter
- Just chatting/joking between users
- Rhetorical questions or sarcasm ("askers?", "who asked?", etc.)
- Meta-discussion about the bot itself ("the bot should...", "limit when bot...")
- Someone else already answered
- They're responding to someone else (not asking the room)
- One-word or two-word messages
- Messages that are reactions/commentary ("lmao", "bro", "oh my god", etc.)

CRITICAL: When in doubt, answer FALSE. It's better to miss a question than to interrupt conversations.

JSON response:`;

    // Belt and braces: the handler already returned if muted, but this is a direct paid call.
    if (isGenerationMuted(KILL_SWITCH_PATH)) {
      logger.warn('🛑 Kill switch active — skipping proactive judgment');
      return false;
    }

    // Use direct OpenRouter call to avoid capability orchestration
    // The full chat endpoint includes email/calendar capabilities that can hijack the response
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      logger.warn('No OpenRouter API key for proactive judgment');
      return false;
    }

    // Same base-URL convention as every other call site (was hardcoded to a separate router;
    // set PROACTIVE_JUDGMENT_BASE_URL=https://router.tools.ejfox.com/v1 to go back to it).
    const judgmentBaseUrl = trimTrailingSlash(
      process.env.PROACTIVE_JUDGMENT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
    );
    // judgmentModel() may be an "auto:<tier>" spec — see shared model-spec.ts
    const judgmentSpec = resolveModelSpec(judgmentModel());
    // Never for openrouter/auto (responseFormatForModel's rule), so the auto branch is unchanged.
    const responseFormat = await engine.responseFormatForModel(judgmentSpec.model, JUDGMENT_OUTPUT);
    const openRouterResponse = await fetch(`${judgmentBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie Proactive Judgment',
      },
      body: JSON.stringify({
        ...(isAutoRouted(judgmentSpec.model)
          ? {
              model: judgmentSpec.model,
              plugins: judgmentSpec.plugins,
              usage: { include: true },
              reasoning: autoReasoningFor(judgmentSpec.plugins),
            }
          : { model: judgmentSpec.model }),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200, // Small response - just need yes/no JSON
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });

    if (!openRouterResponse.ok) {
      throw new Error(`OpenRouter returned ${openRouterResponse.status}`);
    }

    const openRouterResult = (await openRouterResponse.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
    };
    const rawResponse = openRouterResult.choices?.[0]?.message?.content || '';

    // Track proactive judgment cost
    // Auto-routed: record the model OpenRouter actually served, not "openrouter/auto".
    const judgmentModelId = openRouterResult.model || resolveModelSpec(judgmentModel()).model;
    try {
      const usage = openRouterResult.usage;
      // Estimate tokens from char length if API doesn't return usage
      const promptTokens = usage?.prompt_tokens || estimateTokens(prompt);
      const completionTokens = usage?.completion_tokens || estimateTokens(rawResponse);
      const [inRate, outRate] = JUDGMENT_PRICING[judgmentModelId] ?? UNKNOWN_JUDGMENT_PRICING;
      // Prefer OpenRouter's reported USD cost (usage accounting) — auto-router picks are often
      // models with no row in JUDGMENT_PRICING, which would book at the high unknown rate.
      const estimatedCost =
        typeof usage?.cost === 'number'
          ? usage.cost
          : (promptTokens / 1000) * inRate + (completionTokens / 1000) * outRate;
      const db = getSyncDb();
      db.run(
        `INSERT INTO model_usage_stats (
          model_name, user_id, message_id, input_length, output_length,
          response_time_ms, capabilities_detected, capabilities_executed,
          capability_types, success, prompt_tokens, completion_tokens,
          total_tokens, estimated_cost, step_type, guild_id
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '', 1, ?, ?, ?, ?, ?, ?)`,
        [
          judgmentModelId, message.author.id, message.id,
          prompt.length, rawResponse.length, 0,
          promptTokens, completionTokens, promptTokens + completionTokens,
          estimatedCost, 'proactive_judgment', message.guildId ?? null,
        ]
      );
      logger.info(`📊 Proactive judgment cost: ${judgmentModelId} - ${promptTokens + completionTokens} tokens - $${estimatedCost.toFixed(6)}`);
    } catch (costError) {
      logger.warn(`📊 Failed to record proactive judgment cost:`, costError);
    }

    // Parse JSON response
    try {
      // Extract JSON from response (in case there's extra text)
      const judgment = parseModelJson<{
        answer: boolean;
        confidence: number;
        reason: string;
      }>(rawResponse, 'object');
      if (judgment) {
        logger.info(
          `🤔 Proactive judgment: answer=${judgment.answer}, confidence=${judgment.confidence}, reason="${judgment.reason}"`
        );

        // Require confidence > 0.7 to answer (be conservative)
        const shouldAnswer = judgment.answer && judgment.confidence > 0.7;
        logger.info(
          `🤔 Final decision for "${message.content.substring(0, 50)}...": ${shouldAnswer ? 'YES' : 'NO'}`
        );
        return shouldAnswer;
      }
    } catch (parseError) {
      logger.warn(`Failed to parse judgment JSON: ${rawResponse}`);
    }

    // Fallback: check for yes/no in response
    const decision = rawResponse.toLowerCase().trim();
    logger.info(
      `🤔 Fallback judgment for "${message.content.substring(0, 50)}...": "${rawResponse}" -> ${decision.includes('yes') ? 'YES' : 'NO'}`
    );
    return decision.includes('yes');
  } catch (error) {
    logger.warn(`Failed proactive answer judgment, defaulting to no:`, error);
    return false; // Default to not answering if judgment fails
  }
}

/**
 * Proactive answering (robot channels only): cheap heuristics first, then the paid judgment.
 * On a YES sets responseConditions.isProactiveAnswer and returns the guild context to pass.
 */
export async function checkProactiveAnswer(
  message: Message,
  client: Client,
  guildConfig: GuildConfig | null,
  responseConditions: ResponseConditions,
  correlationId: string,
  shortId: string
): Promise<string | undefined> {
  // Check for proactive answering (guild has it enabled + message looks like a question)
  let proactiveAnswerContext: string | undefined;
  const channelNameDebug = ('name' in message.channel ? message.channel.name : 'DM') || 'unknown';

  // Pre-filter: basic sanity + cheap heuristics before expensive LLM judgment
  const wordCount = message.content.trim().split(/\s+/).length;
  const meetsMinimumLength = wordCount >= 5; // real questions worth answering are rarely <5 words

  // If the message @mentions another human (not the bot), it's directed at that person,
  // not asking the room — don't barge in. This is the main "stop interrupting" guard.
  const mentionsAnotherHuman = message.mentions.users.some(
    (u) => u.id !== client.user?.id && !u.bot
  );

  // Cheap heuristic: detect announcements/agendas/status updates
  // These are sharing, not asking — skip LLM judgment entirely
  const contentLower = message.content.toLowerCase().trim();
  const hasBulletPoints = /^[\s]*[*\-•]\s/m.test(message.content) || /\n[\s]*[*\-•]\s/m.test(message.content);
  const hasNumberedList = /^[\s]*\d+[.)]\s/m.test(message.content) || /\n[\s]*\d+[.)]\s/m.test(message.content);
  const hasQuestionMark = message.content.includes('?');
  const startsWithAnnouncement = /^(agenda|update|fyi|heads up|reminder|note|announcement|schedule|plan)\b/i.test(contentLower);
  const looksLikeAnnouncement = (hasBulletPoints || hasNumberedList) && !hasQuestionMark;
  const isStatusUpdate = startsWithAnnouncement || looksLikeAnnouncement;

  // Require an actual question signal before spending an LLM judgment call: a "?" or a
  // leading question word. A plain statement no longer triggers the judgment call.
  const startsWithQuestionWord =
    /^\s*(who|what|when|where|why|how|is|are|can|could|should|would|does|do|did|will|any(one|body)|has|have)\b/i.test(
      contentLower
    );
  const isQuestion =
    meetsMinimumLength &&
    !isStatusUpdate &&
    !mentionsAnotherHuman &&
    (hasQuestionMark || startsWithQuestionWord);

  logger.info(
    `🔍 Proactive check: guild=${guildConfig?.name || 'none'}, channel=#${channelNameDebug}, proactive=${guildConfig?.proactiveAnswering}, wordCount=${wordCount}, looksLikeQuestion=${isQuestion}, isStatusUpdate=${isStatusUpdate}, mentioned=${responseConditions.botMentioned} [${shortId}]`
  );

  if (
    guildConfig?.proactiveAnswering &&
    guildConfig.context &&
    responseConditions.isRobotChannel && // HARD GATE: proactive answering only in robot channels — also avoids burning an LLM judgment call anywhere else
    !responseConditions.botMentioned && // Don't need proactive check if already mentioned
    !responseConditions.repliedToBot &&
    !responseConditions.isDM &&
    isQuestion
  ) {
    // Check 1: Channel whitelist - only answer in designated help channels
    const channelName = ('name' in message.channel ? message.channel.name : '') || '';
    const channelNameLower = channelName.toLowerCase();
    const allowedChannels = guildConfig.proactiveChannels || [];
    const isAllowedChannel =
      allowedChannels.length === 0 ||
      allowedChannels.some((ch) => channelNameLower.includes(ch.toLowerCase()));

    if (!isAllowedChannel) {
      logger.info(
        `🚫 Proactive answer skipped - channel #${channelName} not in whitelist [${shortId}]`
      );
    } else if (message.reference && !message.mentions.has(client.user?.id || '')) {
      // Check: Don't interrupt user-to-user conversations
      // If this is a reply to another message and doesn't mention us, skip proactive answering
      // We still observe and learn from these conversations, but don't butt in
      logger.info(
        `🚫 Proactive answer skipped - user is replying to another user, not interrupting [${shortId}]`
      );
    } else {
      // Check 2: Cooldown - don't spam the server
      const cooldownSeconds = guildConfig.proactiveCooldownSeconds || 60;
      const lastProactive = proactiveCooldownCache.get(message.guildId || '') || 0;
      const timeSinceLast = (Date.now() - lastProactive) / 1000;

      if (timeSinceLast < cooldownSeconds) {
        logger.info(
          `⏳ Proactive answer skipped - cooldown (${Math.round(cooldownSeconds - timeSinceLast)}s remaining) [${shortId}]`
        );
      } else {
        // Check 3: Conscience/reflection - thoughtful judgment about whether to help
        logger.info(
          `🤔 Checking proactive answer for question in ${guildConfig.name} #${channelName} [${shortId}]`
        );
        const shouldAnswer = await shouldProactivelyAnswer(
          message,
          guildConfig.context,
          correlationId
        );

        if (shouldAnswer) {
          responseConditions.isProactiveAnswer = true;
          proactiveAnswerContext = getEnhancedGuildContext(guildConfig);
          // Update cooldown
          proactiveCooldownCache.set(message.guildId || '', Date.now());
          logger.info(
            `✅ Proactive answer approved for ${guildConfig.name} #${channelName} [${shortId}]`
          );
          telemetry.logEvent(
            'proactive_answer_approved',
            { guildId: message.guildId, guildName: guildConfig.name, channel: channelName },
            correlationId,
            message.author.id
          );
        }
      }
    }
  }
  return proactiveAnswerContext;
}

/**
 * respondToAll personas (e.g. Judge Artie): skip trivial banter and enforce the per-channel
 * cooldown. Returns whether the persona channel still answers this message unprompted.
 */
export function throttleRespondToAll(
  message: Message,
  channelPersona: ChannelPersona | null,
  responseConditions: ResponseConditions,
  isRespondToAllChannel: boolean,
  shortId: string
): boolean {
  // Throttle respondToAll personas (e.g. Judge Artie) so they don't reply to every single
  // message and burn an LLM call each time. Mentions still bypass this. Skip trivial banter
  // and enforce a per-channel cooldown.
  if (
    isRespondToAllChannel &&
    !responseConditions.botMentioned &&
    !responseConditions.repliedToBot &&
    channelPersona
  ) {
    const minWords = channelPersona.respondToAllMinWords ?? 2;
    const cooldownSeconds =
      channelPersona.respondToAllCooldownSeconds ?? RESPOND_TO_ALL_COOLDOWN_SECONDS;
    const personaWordCount = message.content.trim().split(/\s+/).filter(Boolean).length;
    const lastResponse = channelResponseCooldownCache.get(message.channelId) || 0;
    const onCooldown = (Date.now() - lastResponse) / 1000 < cooldownSeconds;

    if (personaWordCount < minWords) {
      logger.info(`⚖️ respondToAll skipped - message too short (${personaWordCount}w) [${shortId}]`);
      isRespondToAllChannel = false;
    } else if (onCooldown) {
      logger.info(`⚖️ respondToAll skipped - channel on cooldown (${cooldownSeconds}s) [${shortId}]`);
      isRespondToAllChannel = false;
    }
  }
  return isRespondToAllChannel;
}

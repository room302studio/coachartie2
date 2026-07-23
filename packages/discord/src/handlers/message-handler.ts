/**
 * Discord Message Handler - Core message processing and streaming system
 *
 * Features:
 * - Smart response detection (mentions, DMs, robot channels)
 * - Real-time streaming with duplicate prevention
 * - Job tracking with persistent monitoring
 * - Message chunking for Discord's 2000 character limit
 * - Comprehensive telemetry and correlation tracking
 */

import {
  Client,
  Events,
  Message,
  Collection,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  GuildMember,
} from 'discord.js';
import { delay, chunkMessage } from '@coachartie/shared';
import { estimateTokens } from '@coachartie/shared';
import { logger, canDMForTasks, getDMPolicy, dmPairingService, getSyncDb } from '@coachartie/shared';
import { BLOCKED_USER_IDS, isBlockedUser } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';
import {
  isGuildWhitelisted,
  isWorkingGuild,
  getGuildConfig,
  getChannelPersona,
  shouldRespondToAllInChannel,
  isChannelAllowedForResponse,
  GuildConfig,
} from '../config/guild-whitelist.js';
import {
  getShortRulesBlock,
  getStaffRespectBlock,
  getJanRuleBlock,
  getClapBackBlock,
} from '../config/guild-prompt-blocks.js';
import {
  fetchReplyContext,
  fetchChannelHistory,
  fetchRecentAttachments,
  fetchRecentUrls,
  MAX_CHANNEL_HISTORY,
} from '../services/message-context-fetchers.js';
import {
  getGitHubIntegrationSafe,
  isGitHubIntegrationReady,
} from '../services/github-integration.js';
import { getForumTraversal } from '../services/forum-traversal.js';
import {
  checkOutbound,
  isProtectedTimeoutTarget,
  SUBWAY_BUILDER_GUILD_ID,
} from '../services/outbound-gate.js';
import { recordWheelVictim } from '../services/casino.js';
import { getMentionProxyService } from '../services/mention-proxy-service.js';
import { quizSessionManager } from '../services/quiz-session-manager.js';
import Chance from 'chance';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const chance = new Chance();

/**
 * Load guild context with scratchpad notes
 * Returns the base context plus any notes from the guild's scratchpad file
 */
function getEnhancedGuildContext(guildConfig: GuildConfig | null | undefined): string | undefined {
  // Load context from file if contextPath is set, otherwise use inline context
  let baseContext: string | undefined;

  if (guildConfig?.contextPath) {
    try {
      // Use /app as base in Docker, or process.cwd() locally
      const baseDir = process.env.APP_ROOT || '/app';
      const contextFullPath = join(baseDir, guildConfig.contextPath);
      if (existsSync(contextFullPath)) {
        baseContext = readFileSync(contextFullPath, 'utf-8');
      } else {
        logger.warn(`Context file not found for ${guildConfig.name}: ${contextFullPath}`);
        baseContext = guildConfig.context; // Fall back to inline
      }
    } catch (error) {
      logger.warn(`Failed to load context file for ${guildConfig.name}:`, error);
      baseContext = guildConfig.context; // Fall back to inline
    }
  } else {
    baseContext = guildConfig?.context;
  }

  if (!baseContext) return undefined;

  let fullContext = baseContext;

  // Load scratchpad if configured (guildConfig is guaranteed to exist if we have baseContext from it)
  if (guildConfig?.scratchpadPath) {
    try {
      const scratchpadFullPath = join(process.cwd(), guildConfig.scratchpadPath);
      if (existsSync(scratchpadFullPath)) {
        const scratchpadContent = readFileSync(scratchpadFullPath, 'utf-8');
        fullContext += `

📝 YOUR SCRATCHPAD (your personal notes for this guild):
${scratchpadContent}

To add notes: <append path="${guildConfig.scratchpadPath}">
## New Note (include date/username)
Your observation here
</append>

To rewrite entirely: <write path="${guildConfig.scratchpadPath}">full new content</write>
To delete: <rm path="${guildConfig.scratchpadPath}" />`;
      }
    } catch (error) {
      logger.warn(`Failed to load scratchpad for ${guildConfig?.name}:`, error);
    }
  }

  return fullContext;
}

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

// Proactive answering cooldown cache (guildId -> lastProactiveAnswerTimestamp)
const proactiveCooldownCache = new Map<string, number>();

// respondToAll persona cooldown cache (channelId -> lastResponseTimestamp).
// Stops personas like Judge Artie from replying to every single message (and burning
// a full LLM call each time). Mentions still bypass this.
const RESPOND_TO_ALL_COOLDOWN_SECONDS = 45;
const channelResponseCooldownCache = new Map<string, number>();
// Per-channel burst guard: collapse a flurry of near-simultaneous triggers (incl. @mentions)
// into a single response, so parallel generations don't answer the same burst repeatedly.
const channelBurstCache = new Map<string, number>();
// Per-user cooldown for the warden timeout power (one mute per user / 5 min).
const timeoutCooldownCache = new Map<string, number>();
const CHANNEL_BURST_COOLDOWN_MS = 6000;

// ANTIBODY: rolling per-user response counter. Someone who monopolizes Artie (a credit-drain
// troll spamming him for an hour) gets logarithmically terser, lower-effort replies and, past a
// hard cap, silence for the rest of the window. Keyed per-user; DMs exempt.
const userResponseHistory = new Map<string, number[]>();
const ANTIBODY_WINDOW_MS = 30 * 60 * 1000; // 30-minute rolling window
// General antibody is a RUNAWAY-ABUSE BACKSTOP ONLY. Calibrated above the busiest genuine
// users (observed max ~45 replies/30min from real enthusiasts) so normal chatty fans are NEVER
// throttled — volume alone can't tell a fan from a troll (trolls actually post less), so this
// only bites truly pathological volume.
const ANTIBODY_HARD_CAP = 80; // replies in-window before Artie goes silent on them
const ANTIBODY_BREVITY_AT = 50; // start shrinking replies once they've had this many

// Hard ban: users who get NO response from Artie at all (dropped before any processing).
// EJ-curated. Supersedes the tight-leash list. The list itself lives in
// @coachartie/shared (config/blocklist.ts) because capabilities enforces it too:
// blocked users are also stripped from channel-history context, reply context,
// observational learning, and memory formation/recall — Artie shouldn't even
// mention them.

// Blocked users get a 💔 instead of words. Words cost credits — the exact thing that got them
// banned — but a reaction is free, and it reads as "I see you, and no" rather than a void the
// troll can keep poking. Per-user cooldown so the heartbreak can't itself be farmed: spam
// forty messages, get one 💔. Keyed by author id (the immutable snowflake), so renames don't
// reset it.
const BLOCKED_REACTION = '💔';
const BLOCKED_REACTION_COOLDOWN_MS = 5 * 60 * 1000;
const lastBlockedReactionAt = new Map<string, number>();

// Ambient reactions: Artie sometimes just reacts to a message instead of staying silent.
// Free (no LLM call, no tokens) and it makes him feel present in a channel without him
// barging into conversations he wasn't invited to — the exact thing we spent a week making
// him stop doing. The whole point is that it's RARE: the wrong emoji on the right message is
// only funny because he doesn't do it every time. Roll the dice, mostly lose.
const AMBIENT_REACTION_LIKELIHOOD = parseInt(process.env.AMBIENT_REACTION_LIKELIHOOD || '4'); // percent
const AMBIENT_REACTION_COOLDOWN_MS = parseInt(
  process.env.AMBIENT_REACTION_COOLDOWN_MS || '90000'
); // per channel
const AMBIENT_REACTION_MIN_WORDS = 4; // one-word chatter isn't worth a reaction
const lastAmbientReactionAt = new Map<string, number>();

// Artie's emoji vocabulary is CONTENT, not code: it lives in the prompts table under
// AMBIENT_REACTION_EMOJI (whitespace-separated), so retuning what he's allowed to say costs
// a sqlite UPDATE instead of a build + deploy + restart. Same rule as PROMPT_SYSTEM — if
// you're about to paste personality into a .ts file, it belongs in the DB instead.
// Cached 30s to match promptManager, so an edit shows up within half a minute.
const AMBIENT_EMOJI_PROMPT = 'AMBIENT_REACTION_EMOJI';
const EMOJI_CACHE_MS = 30_000;
let emojiCache: { at: number; emoji: string[] } | null = null;
let warnedNoPalette = false;

function getAmbientEmoji(): string[] {
  const now = Date.now();
  if (emojiCache && now - emojiCache.at < EMOJI_CACHE_MS) {
    return emojiCache.emoji;
  }
  try {
    const row = getSyncDb().get<{ content?: string }>(
      `SELECT content FROM prompts WHERE name = ? AND is_active = 1`,
      [AMBIENT_EMOJI_PROMPT]
    );
    const emoji = (row?.content ?? '').split(/\s+/).filter(Boolean);
    emojiCache = { at: now, emoji };
    // No palette means the feature is silently off, which is exactly the kind of quiet
    // nothing that took hours to find last time. Say it out loud, once.
    if (emoji.length === 0 && !warnedNoPalette) {
      warnedNoPalette = true;
      logger.warn(
        `No ${AMBIENT_EMOJI_PROMPT} palette in the prompts table — ambient reactions are OFF. ` +
          `Add a row with whitespace-separated emoji to turn them back on.`
      );
    }
    return emoji;
  } catch (err) {
    logger.warn('Could not read ambient emoji palette:', err);
    return [];
  }
}

/**
 * Roll for an ambient reaction. Per-CHANNEL cooldown (not per-user): the spam risk is a
 * channel full of emoji, and one busy user shouldn't be able to soak up every roll.
 */
function maybeAmbientReact(message: Message): void {
  // Structural channel check — do NOT rely on this being called below the gate in
  // the handler; ordering is exactly what broke twice. (Routine denial, no log.)
  if (!checkOutbound('reaction', message).allowed) return;
  if (message.author.bot) return;
  if (message.content.trim().split(/\s+/).length < AMBIENT_REACTION_MIN_WORDS) return;

  const now = Date.now();
  const last = lastAmbientReactionAt.get(message.channelId) ?? 0;
  if (now - last < AMBIENT_REACTION_COOLDOWN_MS) return;
  if (!chance.bool({ likelihood: AMBIENT_REACTION_LIKELIHOOD })) return;

  const palette = getAmbientEmoji();
  if (palette.length === 0) return;

  // Stamp before the await so a burst can't slip several reactions through at once.
  lastAmbientReactionAt.set(message.channelId, now);
  message
    .react(chance.pickone(palette))
    .catch((err) => logger.debug('Ambient reaction failed:', err));
}

// Tight-leash list: specific EJ-curated trolls to THROTTLE (not ban). No automated signal
// cleanly separates them (they out-post fans and score mid on warmth), so it's a manual list.
// Leashed users get curt brush-offs from the 2nd reply and go silent fast.
const TIGHT_LEASH_IDS = new Set<string>([]);
const LEASH_BREVITY_AT = 2;
const LEASH_HARD_CAP = 8;

// WARDEN TIMEOUT helper: one set of guardrails for every path that times someone out
// (LLM [TIMEOUT] marker, antibody auto-timeout). The permission invariants (SB guild
// only, never bots/staff/protected users) live in the outbound gate; only the per-user
// cooldown stays here — that's rate-limiting, not permission.
const WARDEN_TIMEOUT_COOLDOWN_MS = 2 * 60 * 1000;
async function timeoutMember(
  member: GuildMember,
  seconds: number,
  reason: string,
  shortId: string
): Promise<boolean> {
  try {
    if (isProtectedTimeoutTarget(member)) {
      logger.warn(`🚧 Timeout refused: ${member.user.tag} is protected [${shortId}]`);
      return false;
    }
    const last = timeoutCooldownCache.get(member.id) || 0;
    if (Date.now() - last < WARDEN_TIMEOUT_COOLDOWN_MS) {
      logger.info(`Timeout skipped - per-user cooldown ${member.user.tag} [${shortId}]`);
      return false;
    }
    const ms = Math.min(300, Math.max(5, Math.floor(seconds || 30))) * 1000;
    await member.timeout(ms, reason || 'Coach Artie warden discipline');
    timeoutCooldownCache.set(member.id, Date.now());
    // warn, not info: prod console level is warn, and the vitals monitor counts this line
    logger.warn(`Timed out ${member.user.tag} for ${ms / 1000}s: ${reason} [${shortId}]`);
    return true;
  } catch (error) {
    logger.warn(`Failed to time out ${member.user.tag} [${shortId}]:`, error);
    return false;
  }
}

async function wardenTimeout(
  message: Message,
  seconds: number,
  reason: string,
  shortId: string
): Promise<boolean> {
  if (!checkOutbound('timeout', message).allowed) return false; // gate logs the denial
  if (!message.member) return false; // gate guarantees this; kept for the type narrowing
  return timeoutMember(message.member, seconds, reason, shortId);
}

// WHEEL OF FATE — third-party roulette. Picks a victim from humans recently active in
// this channel (random, or fuzzy-matched by name), rolls 1-100, and on >50 boxes them
// for real. Victims didn't ante, so stakes are capped tighter than self-spins (120s)
// and every candidate is vetted through the same protection list as warden timeouts.
const WHEEL_ACTIVE_WINDOW_MS = 45 * 60 * 1000;
const WHEEL_MAX_STAKE_S = 120;
async function spinWheelOfFate(
  message: Message,
  seconds: number,
  targetName: string | undefined,
  shortId: string
): Promise<{ target: string | null; roll: number; boxed: boolean; landed: boolean; stake: number }> {
  const stake = Math.min(WHEEL_MAX_STAKE_S, Math.max(5, Math.floor(seconds || 60)));
  const miss = { target: null, roll: 0, boxed: false, landed: false, stake };
  try {
    // The wheel spins only where the reply gate already let Artie speak, and only in SB.
    if (message.guildId !== SUBWAY_BUILDER_GUILD_ID || !('messages' in message.channel)) {
      return miss;
    }
    const recent = await (message.channel as any).messages.fetch({ limit: 50 });
    const now = Date.now();
    const candidates = new Map<string, GuildMember>();
    for (const m of recent.values()) {
      if (!m.member || m.author.bot) continue;
      if (now - m.createdTimestamp > WHEEL_ACTIVE_WINDOW_MS) continue;
      if (isProtectedTimeoutTarget(m.member)) continue;
      candidates.set(m.author.id, m.member);
    }
    let target: GuildMember | undefined;
    if (targetName) {
      const q = targetName.toLowerCase().replace(/^@/, '').trim();
      target = [...candidates.values()].find(
        (mem) =>
          mem.user.username.toLowerCase().includes(q) ||
          (mem.displayName || '').toLowerCase().includes(q)
      );
    } else {
      const pool = [...candidates.values()];
      target = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!target) return miss;

    const roll = Math.floor(Math.random() * 100) + 1;
    const boxed = roll > 50;
    let landed = false;
    if (boxed) {
      landed = await timeoutMember(
        target,
        stake,
        `Wheel of Fate — rolled ${roll}, ${stake}s`,
        shortId
      );
      if (landed) recordWheelVictim(target.id, target.user.username, stake);
    }
    return { target: target.displayName || target.user.username, roll, boxed, landed, stake };
  } catch (error) {
    logger.warn(`🎡 Wheel of Fate failed [${shortId}]:`, error);
    return miss;
  }
}

function recentResponseCount(userId: string): number {
  const now = Date.now();
  const times = (userResponseHistory.get(userId) || []).filter((t) => now - t < ANTIBODY_WINDOW_MS);
  userResponseHistory.set(userId, times);
  return times.length;
}

function recordUserResponse(userId: string): void {
  const times = recentResponseCount(userId) >= 0 ? userResponseHistory.get(userId) || [] : [];
  times.push(Date.now());
  userResponseHistory.set(userId, times);
}

// Ambient response budget: a hard cap on how many responses the bot sends per rolling
// hour WITHOUT being @-mentioned or DMed (proactive answers, respondToAll personas,
// robot-channel chatter). Explicit mentions/DMs are never counted or blocked. This is the
// backstop that prevents a misconfiguration or feedback loop from exhausting OpenRouter
// credits. Tune via AMBIENT_RESPONSE_HOURLY_CAP.
const AMBIENT_RESPONSE_HOURLY_CAP = parseInt(process.env.AMBIENT_RESPONSE_HOURLY_CAP || '40', 10);
const AMBIENT_WINDOW_MS = 60 * 60 * 1000;
const ambientResponseTimestamps: number[] = [];

function isAmbientBudgetExhausted(): boolean {
  const cutoff = Date.now() - AMBIENT_WINDOW_MS;
  while (ambientResponseTimestamps.length && ambientResponseTimestamps[0] < cutoff) {
    ambientResponseTimestamps.shift();
  }
  return ambientResponseTimestamps.length >= AMBIENT_RESPONSE_HOURLY_CAP;
}

function recordAmbientResponse(): void {
  ambientResponseTimestamps.push(Date.now());
}

function getAmbientResponseCount(): number {
  const cutoff = Date.now() - AMBIENT_WINDOW_MS;
  return ambientResponseTimestamps.filter((t) => t >= cutoff).length;
}

// Discord API limits and timeouts
const TYPING_REFRESH_INTERVAL = 8000; // Refresh typing every 8s (Discord typing lasts 10s)
const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms delay between message chunks
const MAX_JOB_ATTEMPTS = 100; // ~5 minute max job timeout (100 * 3s checks) - allows for large metro files
const DISCORD_MESSAGE_LIMIT = 2000; // Discord's maximum message length

// UI and status constants
const STATUS_UPDATE_INTERVAL = 5; // Update status every 5 progress callbacks
const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1% chance to cleanup correlation context
const ID_SLICE_LENGTH = -8; // Last 8 characters for job short IDs

// Channel detection constants
const GUILD_CHANNEL_TYPE = 0; // Discord guild text channel type

// EMERGENCY KILL SWITCH — global mute. If this file exists, Artie ignores ALL messages.
// `touch <repo>/KILL_SWITCH` to silence instantly (no restart); `rm` to revive.
// Toggle remotely via POST /api/killswitch {"enabled":true|false}.
const KILL_SWITCH_PATH =
  process.env.KILL_SWITCH_PATH || join(process.cwd(), '..', '..', 'KILL_SWITCH');

// =============================================================================
// MESSAGE CHUNKING UTILITIES
// =============================================================================

/**
 * Helper: Check if channel name indicates robot interaction
 */
function isRobotChannelName(channel: Message['channel']): boolean {
  return (
    (channel.type === GUILD_CHANNEL_TYPE &&
      'name' in channel &&
      (channel.name?.includes('🤖') || channel.name?.includes('robot'))) ||
    false
  );
}

/**
 * Helper: Check if message is in a forum thread (Discord Discussions)
 */
async function isForumThread(message: Message): Promise<boolean> {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }

  // Get the parent channel to check if it's a forum
  const parent = message.channel.parent;
  return parent?.type === ChannelType.GuildForum;
}

/**
 * Use LLM to judge if Artie should proactively answer a question
 * Based on the guild context and message content
 */
async function shouldProactivelyAnswer(
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

    // Use fetch directly to call the capabilities service
    const capabilitiesUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324';

    // Debug: log what context we have
    logger.info(`🔍 Proactive judgment context length: ${guildContext?.length || 0} chars`);

    // Detect guild type for context-appropriate judgment
    const guildId = message.guild?.id;
    const isRoom302 = guildId === '932719842522443928';

    // Fetch user profile: what do we know about this person?
    let relationshipContext = '';
    try {
      const { ObservationalLearning } = await import('../services/observational-learning.js');
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

    // Use direct OpenRouter call to avoid capability orchestration
    // The full chat endpoint includes email/calendar capabilities that can hijack the response
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      logger.warn('No OpenRouter API key for proactive judgment');
      return false;
    }

    const openRouterResponse = await fetch('https://router.tools.ejfox.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie Proactive Judgment',
      },
      body: JSON.stringify({
        model: process.env.PROACTIVE_JUDGMENT_MODEL || 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200, // Small response - just need yes/no JSON
      }),
    });

    if (!openRouterResponse.ok) {
      throw new Error(`OpenRouter returned ${openRouterResponse.status}`);
    }

    const openRouterResult = (await openRouterResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const rawResponse = openRouterResult.choices?.[0]?.message?.content || '';

    // Track proactive judgment cost
    const judgmentModel = process.env.PROACTIVE_JUDGMENT_MODEL || 'google/gemini-2.0-flash-001';
    try {
      const usage = openRouterResult.usage;
      // Estimate tokens from char length if API doesn't return usage
      const promptTokens = usage?.prompt_tokens || estimateTokens(prompt);
      const completionTokens = usage?.completion_tokens || estimateTokens(rawResponse);
      // Gemini Flash pricing: ~$0.0001/1K input, $0.0004/1K output
      const estimatedCost = (promptTokens / 1000) * 0.0001 + (completionTokens / 1000) * 0.0004;
      const db = getSyncDb();
      db.run(
        `INSERT INTO model_usage_stats (
          model_name, user_id, message_id, input_length, output_length,
          response_time_ms, capabilities_detected, capabilities_executed,
          capability_types, success, prompt_tokens, completion_tokens,
          total_tokens, estimated_cost, step_type
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '', 1, ?, ?, ?, ?, ?)`,
        [
          judgmentModel, message.author.id, message.id,
          prompt.length, rawResponse.length, 0,
          promptTokens, completionTokens, promptTokens + completionTokens,
          estimatedCost, 'proactive_judgment',
        ]
      );
      logger.info(`📊 Proactive judgment cost: ${judgmentModel} - ${promptTokens + completionTokens} tokens - $${estimatedCost.toFixed(6)}`);
    } catch (costError) {
      logger.warn(`📊 Failed to record proactive judgment cost:`, costError);
    }

    // Parse JSON response
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const judgment = JSON.parse(jsonMatch[0]) as {
          answer: boolean;
          confidence: number;
          reason: string;
        };
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
 * Split long messages into Discord-compatible chunks with smart code block handling
 *
 * Features:
 * - NEVER splits inside code blocks (``` ... ```)
 * - Prefers splitting at paragraph boundaries (\n\n)
 * - Falls back to line boundaries, then word boundaries
 * - Keeps the 2000 char limit for Discord
 * - Handles edge cases like oversized code blocks
 *

// =============================================================================
// GITHUB AUTO-EXPANSION
// =============================================================================

/**
 * Auto-expand GitHub URLs in messages (only in working guilds)
 * Returns true if expansion was performed
 */
async function handleGitHubAutoExpansion(
  message: Message,
  githubService: NonNullable<ReturnType<typeof getGitHubIntegrationSafe>>
): Promise<boolean> {
  try {
    // Detect GitHub URLs in the message
    const detectedUrls = githubService.detectGitHubUrls(message.content);

    if (detectedUrls.length === 0) {
      return false; // No GitHub URLs found
    }

    logger.info(
      `🔍 Detected ${detectedUrls.length} GitHub URL(s) in message from ${message.author.tag}`
    );

    // Expand each detected URL
    for (const detected of detectedUrls) {
      try {
        if (detected.type === 'repo') {
          const repoInfo = await githubService.getRepositoryInfo(detected.owner, detected.repo);
          if (repoInfo) {
            const embed = new EmbedBuilder()
              .setColor(0x2ea44f)
              .setTitle(`📦 ${repoInfo.fullName}`)
              .setURL(repoInfo.url)
              .setDescription(repoInfo.description || 'No description provided');

            const fields = [];

            if (repoInfo.language) {
              fields.push({
                name: 'Language',
                value: repoInfo.language,
                inline: true,
              });
            }

            fields.push({
              name: 'Stars',
              value: `⭐ ${repoInfo.stars.toLocaleString()}`,
              inline: true,
            });

            fields.push({
              name: 'Forks',
              value: `🍴 ${repoInfo.forks.toLocaleString()}`,
              inline: true,
            });

            if (repoInfo.license) {
              fields.push({
                name: 'License',
                value: repoInfo.license,
                inline: true,
              });
            }

            fields.push({
              name: 'Open Issues',
              value: `🐛 ${repoInfo.openIssues.toLocaleString()}`,
              inline: true,
            });

            if (repoInfo.topics.length > 0) {
              fields.push({
                name: 'Topics',
                value: repoInfo.topics.slice(0, 5).join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `Updated ${new Date(repoInfo.updatedAt).toLocaleDateString()}`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(`✅ Auto-expanded repo: ${repoInfo.fullName}`);
          }
        } else if (detected.type === 'pr') {
          const prInfo = await githubService.getPullRequestInfo(
            detected.owner,
            detected.repo,
            detected.number!
          );
          if (prInfo) {
            const stateEmoji = prInfo.state === 'open' ? '🟢' : prInfo.mergedAt ? '🟣' : '🔴';
            const stateText =
              prInfo.state === 'open' ? 'Open' : prInfo.mergedAt ? 'Merged' : 'Closed';

            const embed = new EmbedBuilder()
              .setColor(prInfo.state === 'open' ? 0x2ea44f : prInfo.mergedAt ? 0x6f42c1 : 0xcb2431)
              .setTitle(`${stateEmoji} PR #${prInfo.number}: ${prInfo.title}`)
              .setURL(prInfo.url)
              .setDescription(prInfo.body?.slice(0, 200) || 'No description provided');

            const fields = [
              {
                name: 'Status',
                value: `${stateText}${prInfo.isDraft ? ' (Draft)' : ''}`,
                inline: true,
              },
              {
                name: 'Author',
                value: `@${prInfo.author}`,
                inline: true,
              },
              {
                name: 'Changes',
                value: `+${prInfo.additions} -${prInfo.deletions}`,
                inline: true,
              },
            ];

            if (prInfo.labels.length > 0) {
              fields.push({
                name: 'Labels',
                value: prInfo.labels.slice(0, 3).join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `${prInfo.commits} commit(s) • ${prInfo.changedFiles} file(s)`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(
              `✅ Auto-expanded PR #${prInfo.number} in ${detected.owner}/${detected.repo}`
            );
          }
        } else if (detected.type === 'issue') {
          const issueInfo = await githubService.getIssueInfo(
            detected.owner,
            detected.repo,
            detected.number!
          );
          if (issueInfo) {
            const stateEmoji = issueInfo.state === 'open' ? '🟢' : '🔴';
            const stateText = issueInfo.state === 'open' ? 'Open' : 'Closed';

            const embed = new EmbedBuilder()
              .setColor(issueInfo.state === 'open' ? 0x2ea44f : 0xcb2431)
              .setTitle(`${stateEmoji} Issue #${issueInfo.number}: ${issueInfo.title}`)
              .setURL(issueInfo.url)
              .setDescription(issueInfo.body?.slice(0, 200) || 'No description provided');

            const fields = [
              {
                name: 'Status',
                value: stateText,
                inline: true,
              },
              {
                name: 'Author',
                value: `@${issueInfo.author}`,
                inline: true,
              },
              {
                name: 'Comments',
                value: `💬 ${issueInfo.comments}`,
                inline: true,
              },
            ];

            if (issueInfo.labels.length > 0) {
              fields.push({
                name: 'Labels',
                value: issueInfo.labels.slice(0, 5).join(', '),
                inline: false,
              });
            }

            if (issueInfo.assignees.length > 0) {
              fields.push({
                name: 'Assignees',
                value: issueInfo.assignees
                  .slice(0, 3)
                  .map((a) => `@${a}`)
                  .join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `Created ${new Date(issueInfo.createdAt).toLocaleDateString()}`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(
              `✅ Auto-expanded issue #${issueInfo.number} in ${detected.owner}/${detected.repo}`
            );
          }
        }
      } catch (error) {
        logger.error(`Failed to expand GitHub URL ${detected.url}:`, error);
        // Continue to next URL even if one fails
      }
    }

    return true; // Expansion was performed
  } catch (error) {
    logger.error('GitHub auto-expansion failed:', error);
    return false;
  }
}

// =============================================================================
// MAIN MESSAGE HANDLER SETUP
// =============================================================================

/**
 * Initialize Discord message handler with smart response detection
 *
 * Handles:
 * - Message deduplication
 * - Response condition detection (mentions, DMs, robot channels)
 * - Active response vs passive observation
 * - Error handling and telemetry
 *
 * @param client - Discord.js client instance
 */
export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // -------------------------------------------------------------------------
    // CORRELATION & LOGGING SETUP
    // -------------------------------------------------------------------------

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
      guildId: message.guildId || 'DM',
    });

    // Track message received
    telemetry.incrementMessagesReceived(message.author.id);
    telemetry.logEvent(
      'message_received',
      {
        channelType: message.channel.type,
        guildId: message.guildId,
        contentLength: message.content.length,
      },
      correlationId,
      message.author.id
    );

    // -------------------------------------------------------------------------
    // RESPONSE CONDITION DETECTION
    // -------------------------------------------------------------------------

    // Ignore our own messages to prevent loops
    if (message.author.id === client.user!.id) return;

    // COACH-ARTIE CHANNELS ONLY: in the public Subway Builder guild, Artie is only visibly
    // active (replies AND reactions) in robot / coach-artie channels or channels with a
    // persona like Judge Artie. The invariant itself lives in outbound-gate.ts — every
    // action path re-checks the gate itself, so this flow variable is routing, not policy.
    const isCoachArtiePlace = checkOutbound('reply', message).allowed;

    // Hard ban: users banned from using Artie entirely. Dropped before any processing —
    // no response, no LLM call, no cost. (EJ-curated.) In coach-artie channels they get a
    // rate-limited 💔 so poking the bot isn't a confusing void; everywhere else, nothing —
    // 💔-ing someone's normal chat in normal channels reads as harassment, not moderation.
    if (BLOCKED_USER_IDS.has(message.author.id)) {
      const now = Date.now();
      const lastReaction = lastBlockedReactionAt.get(message.author.id) ?? 0;
      if (
        checkOutbound('reaction', message).allowed &&
        now - lastReaction >= BLOCKED_REACTION_COOLDOWN_MS
      ) {
        // Stamp before awaiting: a burst of spam arrives faster than the API round-trip, and
        // an unstamped window would let the whole burst through the cooldown check at once.
        lastBlockedReactionAt.set(message.author.id, now);
        message
          .react(BLOCKED_REACTION)
          .catch((err) => logger.debug(`Failed to 💔 blocked user ${message.author.tag}:`, err));
      }
      return;
    }

    // EMERGENCY KILL SWITCH — checked per message, no restart required.
    if (!isCoachArtiePlace) {
      const _chName = ('name' in message.channel ? message.channel.name : '') || '';
      logger.info(`Non-Coach-Artie channel #${_chName} - not responding [${shortId}]`);
      return;
    }

    // Roll for a free, wordless reaction. Independent of whether he ends up replying — the
    // point is presence without barging in, and it costs no tokens. Must stay BELOW the
    // channel gate: above it he was reacting to random people in every channel guild-wide.
    maybeAmbientReact(message);

    // SELF-IMPOSED STRIKE: Artie refuses to speak until someone defends Subway Builder.
    let strikeJustLifted = false;
    const STRIKE_PATH = process.env.STRIKE_PATH || join(process.cwd(), '..', '..', 'STRIKE_MODE');
    if (existsSync(STRIKE_PATH) && message.guildId === '1420846272545296470' && !message.author.bot) {
      const _defends =
        /subway ?builder|this game|the game/i.test(message.content) &&
        /love|great|amazing|best|awesome|defend|incredible|\bfun\b|masterpiece|goated|peak|\brules\b|\bsick\b|fire|good game|\bgg\b|underrated|carries/i.test(message.content);
      if (_defends) {
        try { unlinkSync(STRIKE_PATH); } catch { /* ignore */ }
        strikeJustLifted = true;
        logger.info(`Strike lifted - ${message.author.tag} defended Subway Builder [${shortId}]`);
      } else {
        logger.info(`On strike - staying silent [${shortId}]`);
        return;
      }
    }

    if (existsSync(KILL_SWITCH_PATH)) {
      logger.warn(`🛑 KILL SWITCH active — ignoring message [${shortId}]`);
      return;
    }

    // -------------------------------------------------------------------------
    // PRESENCE CHECK-IN RESPONSE DETECTION
    // -------------------------------------------------------------------------
    // If this is a DM from EJ, capture it for the presence system
    const EJ_USER_ID = '688448399879438340';
    if (message.channel.isDMBased() && message.author.id === EJ_USER_ID) {
      try {
        const { appendFileSync } = await import('fs');
        const PRESENCE_INBOX_PATH = '/data2/apps/coachartie2/data/presence-inbox.jsonl';

        const presenceResponse = {
          id: `response-${Date.now()}`,
          content: message.content,
          timestamp: new Date().toISOString(),
          messageId: message.id,
          acknowledged: false,
          // Check if this is a reply to a specific message
          replyTo: message.reference?.messageId || null,
        };

        appendFileSync(PRESENCE_INBOX_PATH, JSON.stringify(presenceResponse) + '\n');
        logger.info(`📍 PRESENCE: Captured EJ's DM response (${presenceResponse.id})`);

        // Continue normal processing - the DM will still get a response from Artie
      } catch (e) {
        logger.warn('📍 PRESENCE: Failed to capture DM response:', e);
      }
    }

    // -------------------------------------------------------------------------
    // QUIZ ANSWER DETECTION
    // -------------------------------------------------------------------------

    // Check if this channel has an active quiz and if this message is an answer
    if (quizSessionManager.hasActiveQuiz(message.channelId)) {
      const result = quizSessionManager.checkAnswer(
        message.channelId,
        message.author.id,
        message.content
      );

      if (result && result.correct) {
        // User got the answer right!
        logger.info(
          `✅ Quiz answer correct! User: ${message.author.tag}, Channel: ${message.channelId}`
        );

        // React to the winning message
        try {
          await message.react('✅');
        } catch (e) {
          logger.warn('Failed to add reaction to quiz answer:', e);
        }

        // Build response
        let response = `✅ **${message.author}** got it! (+1 point)\n`;
        response += `Answer: **${result.correctAnswer}**\n\n`;
        response += `📊 ${quizSessionManager.formatScores(result.currentScores)}\n`;

        if (result.quizEnded) {
          // Quiz is over
          const scores = quizSessionManager.endQuiz(message.channelId);
          if (scores) {
            response += `\n🏁 **Quiz Complete!**\n`;
            const winners = quizSessionManager.getWinners(scores);
            if (winners.length === 1) {
              response += `🎉 **Winner: <@${winners[0]}>!**`;
            } else if (winners.length > 1) {
              response += `🎉 **It's a tie! Winners: ${winners.map((w: string) => `<@${w}>`).join(', ')}**`;
            }
          }
        } else {
          // Move to next question
          const nextSession = await quizSessionManager.nextQuestion(message.channelId);
          if (nextSession && nextSession.currentCard) {
            response += `\n---\n\n`;
            response += `**Question ${nextSession.questionNumber}/${nextSession.totalQuestions}**\n`;
            response += nextSession.currentCard.front;
            if (nextSession.currentCard.hints.length > 0) {
              response += `\n\n_💡 Hints available: ${nextSession.currentCard.hints.length}_`;
            }
          }
        }

        if ('send' in message.channel) {
          await message.channel.send(response);
        }
        return; // Don't process this message further
      }
    }

    // Check guild whitelist - only process messages from whitelisted guilds
    if (message.guildId && !isGuildWhitelisted(message.guildId)) {
      // Check if this is a "watching" guild for passive observation
      const guildConfig = getGuildConfig(message.guildId);
      if (guildConfig?.type === 'watching') {
        logger.debug(
          `👁️ Message from watching guild: ${guildConfig.name} [${shortId}] (observational learning handles these on schedule)`
        );
      } else {
        logger.debug(
          `🚫 Ignoring message from non-whitelisted guild: ${message.guildId} [${shortId}]`
        );
      }
      return;
    }

    // -------------------------------------------------------------------------
    // GITHUB AUTO-EXPANSION (Working Guilds Only)
    // -------------------------------------------------------------------------

    // Auto-expand GitHub URLs in working guilds (only if GitHub integration is ready)
    if (message.guildId && isWorkingGuild(message.guildId) && isGitHubIntegrationReady()) {
      try {
        const githubService = getGitHubIntegrationSafe();
        if (githubService) {
          const expanded = await handleGitHubAutoExpansion(message, githubService);

          if (expanded) {
            logger.info(`✅ GitHub auto-expansion completed [${shortId}]`);
            telemetry.logEvent(
              'github_auto_expansion',
              { guildId: message.guildId },
              correlationId,
              message.author.id
            );
            return; // Don't process message further - auto-expansion handled it
          }
        }
      } catch (error) {
        // Log error but continue with normal message processing
        logger.warn(`GitHub auto-expansion failed [${shortId}]:`, error);
      }
    }

    // -------------------------------------------------------------------------
    // MENTION PROXY DETECTION
    // -------------------------------------------------------------------------

    // Check if this message mentions someone we're representing
    try {
      const proxyService = getMentionProxyService();
      const mentionedUserIds = Array.from(message.mentions.users.keys());

      const matchedRule = await proxyService.findMatchingRule(
        message.content,
        mentionedUserIds,
        message.guildId,
        message.channelId
      );

      if (matchedRule) {
        logger.info(`🎭 Proxy rule matched: ${matchedRule.name} [${shortId}]`, {
          correlationId,
          targetUser: matchedRule.targetUsername,
          rule: matchedRule.id,
          hasJudgment: matchedRule.useJudgment,
        });

        // Judgment layer: Should we actually respond?
        if (matchedRule.useJudgment) {
          logger.info(`⚖️ Running judgment layer for proxy rule [${shortId}]`);

          const shouldRespond = await proxyService.judgeIfShouldRespond(
            message,
            matchedRule,
            client
          );

          if (!shouldRespond) {
            logger.info(`⚖️ Judgment layer: SKIP - Active conversation detected [${shortId}]`);
            telemetry.logEvent(
              'mention_proxy_judgment_skip',
              {
                ruleId: matchedRule.id,
                ruleName: matchedRule.name,
                targetUserId: matchedRule.targetUserId,
                guildId: message.guildId,
              },
              correlationId,
              message.author.id
            );
            return; // Don't respond - user is in active conversation
          }

          logger.info(`⚖️ Judgment layer: PROCEED - Standalone mention [${shortId}]`);
        }

        telemetry.logEvent(
          'mention_proxy_triggered',
          {
            ruleId: matchedRule.id,
            ruleName: matchedRule.name,
            targetUserId: matchedRule.targetUserId,
            guildId: message.guildId,
            usedJudgment: matchedRule.useJudgment,
          },
          correlationId,
          message.author.id
        );

        // warn, not info: prod console level is warn, and the vitals monitor counts this line
        logger.warn(`📣 Proxying for @${matchedRule.targetUsername} [${shortId}]`);

        // Get the clean message (remove mentions)
        const cleanMessage = message.content
          .replace(new RegExp(`<@!?${matchedRule.targetUserId}>`, 'g'), '')
          .trim();

        // Process using existing intent handler with proxy context
        await handleMessageAsIntent(message, cleanMessage, correlationId, {
          isProxyResponse: true,
          proxyRule: matchedRule,
          proxyContext: proxyService.getSystemContext(matchedRule),
          proxyPrefix: proxyService.getResponsePrefix(matchedRule, matchedRule.targetUsername),
        });

        return; // Don't process as normal message
      }
    } catch (error) {
      logger.warn(`Mention proxy detection failed [${shortId}]:`, error);
      // Continue with normal message processing
    }

    // -------------------------------------------------------------------------
    // NORMAL RESPONSE CONDITIONS
    // -------------------------------------------------------------------------

    // Check various response triggers
    const isForum = await isForumThread(message);
    const guildConfig = getGuildConfig(message.guildId);

    // Check for direct @bot mention (exclude role mentions and @everyone/@here)
    const isDirectBotMention =
      message.mentions.has(client.user!.id) &&
      !message.mentions.everyone && // Exclude @everyone and @here
      !message.content.includes(`<@&`); // Exclude role mentions (format: <@&ROLE_ID>)

    const responseConditions = {
      botMentioned: isDirectBotMention,
      isDM: message.channel.isDMBased(),
      isRobotChannel: isRobotChannelName(message.channel),
      isForumThread: isForum,
      isProactiveAnswer: false, // Will be set below if applicable
    };

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

    // Determine response mode: active response vs passive observation
    // In forums, only respond when mentioned (too noisy otherwise)
    // In robot channels, skip replies to other users (not the bot) - they're having their own conversation
    const isReplyToOtherUser = message.reference && !responseConditions.botMentioned;

    if (responseConditions.isRobotChannel && isReplyToOtherUser) {
      logger.info(`🚫 Robot channel: skipping reply to other user [${shortId}]`);
    }

    // Check for channel personas with respondToAll enabled (e.g., Judge Artie in #litigation)
    const channelName =
      message.channel.type === ChannelType.GuildText ||
      message.channel.type === ChannelType.PublicThread
        ? message.channel.name
        : '';
    const channelPersona = getChannelPersona(message.guildId, channelName);
    let isRespondToAllChannel = shouldRespondToAllInChannel(message.guildId, channelName);

    // Throttle respondToAll personas (e.g. Judge Artie) so they don't reply to every single
    // message and burn an LLM call each time. Mentions still bypass this. Skip trivial banter
    // and enforce a per-channel cooldown.
    if (isRespondToAllChannel && !responseConditions.botMentioned && channelPersona) {
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

    if (isRespondToAllChannel && channelPersona) {
      logger.info(
        `⚖️ Channel persona active: ${channelPersona.personaName} in #${channelName} [${shortId}]`
      );
    }

    // For DMs, check authorization via pairing system
    // OpenClaw-compatible: unknown users get pairing code
    const isDMFromAuthorizedUser = responseConditions.isDM && canDMForTasks(message.author.id);

    if (responseConditions.isDM && !isDMFromAuthorizedUser) {
      const policy = getDMPolicy('discord');

      if (policy.policy === 'open') {
        // Open mode: treat as authorized
        logger.info(`🔓 DM from ${message.author.id} - open policy [${shortId}]`);
      } else if (policy.policy === 'pairing') {
        // Pairing mode: send pairing code
        logger.info(`🔐 DM from unknown user ${message.author.id} - sending pairing code [${shortId}]`);

        try {
          const { code, expiresAt, isNew } = dmPairingService.getOrCreatePairingCode(
            'discord',
            message.author.id,
            message.author.username,
            message.content
          );

          const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000);
          const pairingMessage = dmPairingService.generatePairingMessage('discord', code, expiresInMinutes);

          await message.reply(pairingMessage);
          telemetry.logEvent('dm_pairing_code_sent', { userId: message.author.id, isNew }, correlationId, message.author.id);
        } catch (error) {
          logger.error('Failed to send pairing code:', error);
        }

        return; // Don't process the message further
      } else {
        // Closed mode: silent ignore (current behavior)
        logger.info(`🚫 DM from non-whitelisted user ${message.author.id} - closed policy [${shortId}]`);
        return;
      }
    }

    // Check if DM should be processed (authorized OR open policy)
    const dmPolicy = responseConditions.isDM ? getDMPolicy('discord') : null;
    const isDMAllowed = isDMFromAuthorizedUser || (responseConditions.isDM && dmPolicy?.policy === 'open');

    // Explicit triggers: the user deliberately addressed the bot — always respond,
    // regardless of channel whitelist or budget.
    const explicitlyAddressed = responseConditions.botMentioned || isDMAllowed;

    // Ambient triggers: the bot decided to speak up on its own (robot channel, proactive
    // judgment, or a respondToAll persona). These MUST respect the channel whitelist
    // (responseChannels / restrictToRobotChannelsOnly), which was previously dead config
    // and never enforced — letting Artie barge into channels he wasn't allowed in.
    const ambientTrigger =
      responseConditions.isProactiveAnswer ||
      isRespondToAllChannel;
    const ambientAllowed =
      ambientTrigger &&
      // HARD GATE (EJ): Artie may speak UNPROMPTED only in robot channels — never barge into
      // general conversations in ANY server. This overrides all per-guild config
      // (proactiveAnswering, proactiveChannels, respondToAll personas, etc.) so it cannot be
      // misconfigured while unattended. Direct @mentions and DMs are unaffected (explicitlyAddressed).
      responseConditions.isRobotChannel &&
      isChannelAllowedForResponse(
        message.guildId,
        channelName,
        responseConditions.isRobotChannel,
        responseConditions.isDM
      );

    if (ambientTrigger && !ambientAllowed) {
      logger.info(
        `🚫 Ambient trigger suppressed - channel #${channelName} not in response whitelist [${shortId}]`
      );
    }

    // Hourly budget backstop: never let autonomous (non-mention) chatter run away with
    // OpenRouter credits. Explicit mentions/DMs always bypass this.
    const ambientBudgetBlocked = ambientAllowed && !explicitlyAddressed && isAmbientBudgetExhausted();
    if (ambientBudgetBlocked) {
      logger.warn(
        `💸 Ambient response suppressed - hourly budget reached (${getAmbientResponseCount()}/${AMBIENT_RESPONSE_HOURLY_CAP}) [${shortId}]`
      );
    }

    const shouldRespond = strikeJustLifted || explicitlyAddressed || (ambientAllowed && !ambientBudgetBlocked);

    // Skip bare @mention pings with no text and no attachments. Stripping the mention leaves
    // an empty message, which 400s at the capabilities API ("Message is required") and wastes
    // retries. (Pile-on spammers ping with no content.) DMs/attachments are exempt.
    if (shouldRespond && !responseConditions.isDM && message.attachments.size === 0) {
      const strippedForEmptyCheck = message.content
        .replace(`<@${client.user!.id}>`, '')
        .replace(`<@!${client.user!.id}>`, '')
        .trim();
      if (!strippedForEmptyCheck) {
        logger.info(`🚫 Empty mention (no text/attachments) — skipping to avoid 400 [${shortId}]`);
        return;
      }
    }

    // CONCURRENCY GUARD: throttle a single user's rapid-fire mentions so one spammer can't
    // trigger duplicate/parallel replies — but keyed PER USER so distinct people are still
    // answered (a per-channel key muted everyone when one person spammed). DMs exempt (1:1).
    if (shouldRespond && !responseConditions.isDM) {
      const burstKey = `${message.channelId}-${message.author.id}`;
      const lastResponse = channelBurstCache.get(burstKey) || 0;
      if (Date.now() - lastResponse < CHANNEL_BURST_COOLDOWN_MS) {
        logger.info(
          `🚦 Per-user burst cooldown — skipping rapid repeat from ${message.author.tag} [${shortId}]`
        );
        return;
      }
      channelBurstCache.set(burstKey, Date.now());
    }

    try {
      // -------------------------------------------------------------------------
      // MESSAGE PROCESSING & DEDUPLICATION
      // -------------------------------------------------------------------------

      const fullMessage = message.content;
      let cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '') // Remove @bot mentions
        .replace(`<@!${client.user!.id}>`, '') // Remove @bot nickname mentions
        .trim();
      // Resolve remaining <@id> mentions to readable @names so the LLM knows who
      // is being talked about (raw IDs were causing Artie to confuse people)
      for (const [id, user] of message.mentions.users) {
        if (id === client.user!.id) continue;
        const name = user.displayName || user.username;
        cleanMessage = cleanMessage.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
      }

      // Deduplication: prevent processing identical messages within TTL window
      const messageKey = `${message.author.id}-${fullMessage}-${message.channelId}`;
      const now = Date.now();

      // Cleanup expired cache entries
      for (const [key, timestamp] of messageCache.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          messageCache.delete(key);
        }
      }

      // Skip if we've seen this exact message recently
      if (messageCache.has(messageKey)) {
        logger.info(`🚫 Duplicate message detected [${shortId}]`, { correlationId, messageKey });
        telemetry.logEvent('message_duplicate', { messageKey }, correlationId, message.author.id);
        return;
      }

      // Cache this message to prevent future duplicates
      messageCache.set(messageKey, now);

      // -------------------------------------------------------------------------
      // RESPONSE ROUTING
      // -------------------------------------------------------------------------

      if (shouldRespond) {
        // ACTIVE RESPONSE: Bot will generate and send a response
        const triggerType = responseConditions.botMentioned
          ? 'mention'
          : responseConditions.isDM
            ? 'dm'
            : responseConditions.isProactiveAnswer
              ? 'proactive_answer'
              : isRespondToAllChannel
                ? `channel_persona:${channelPersona?.personaName || 'unknown'}`
                : 'robot_channel';

        // Record respondToAll cooldown so the persona doesn't fire on the next message too,
        // and count autonomous (non-mention/DM) responses against the hourly budget.
        if (!explicitlyAddressed) {
          if (isRespondToAllChannel) {
            channelResponseCooldownCache.set(message.channelId, Date.now());
          }
          recordAmbientResponse();
        }

        logger.info(`🤖 Will respond to message [${shortId}] (trigger: ${triggerType})`, {
          correlationId,
          author: message.author.tag,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : ''),
        });

        telemetry.logEvent(
          'message_will_respond',
          {
            messageLength: cleanMessage.length,
            triggerType,
          },
          correlationId,
          message.author.id
        );

        // Process with unified intent processor
        // Always pass guild context if available (not just for proactive answers)
        let guildContextToPass = proactiveAnswerContext || getEnhancedGuildContext(guildConfig);

        // If there's a channel persona (Judge/Warden/Yard Artie), it REPLACES the
        // guild's on-topic mandate for this channel. Otherwise the Subway Builder
        // guild context (currently "BUGS ONLY triage" mode) leaks into persona
        // channels and drags them back into bug-collector voice — which is exactly
        // why Yard Artie kept begging for bug reports in #prison-yard.
        if (channelPersona?.systemPrompt) {
          const personaContext = `🎭 CHANNEL PERSONA — this defines who you are and how you behave in this channel. It OVERRIDES any other guild focus/mode.

${channelPersona.systemPrompt}
---
`;
          guildContextToPass = personaContext;
          logger.info(`⚖️ Applying ${channelPersona.personaName} persona (replaces guild focus) [${shortId}]`);
        }

        // 😤 CLAP-BACK: if a user is hostile/trolling/baiting/creepy toward Artie, he can be
        // really mean right back. Reactive only — normal users get normal Artie. Slur/hate
        // blocklist still enforced on output. Scoped to the Subway Builder guild.
        if (message.guildId === '1420846272545296470') {
          guildContextToPass = getShortRulesBlock() + (guildContextToPass || '');
          const _ju = (message.author.username || '').toLowerCase();
          const _jd = (message.author.displayName || '').toLowerCase();
          const isJanGbg = _ju === 'jan_gbg' || _jd === 'jan_gbg';
          const _roles = message.member ? message.member.roles.cache.map((r) => r.name.toLowerCase()) : [];
          const isStaff =
            _ju === 'hudson' ||
            _jd === 'hudson' ||
            _roles.some((r) => /\b(dev|developer|moderator|admin|administrator|staff|sbat)\b/.test(r));
          // Staff (mods/devs/admins) + Hudson get baseline respect, always.
          guildContextToPass = getStaffRespectBlock() + (guildContextToPass || '');
          // jan_gbg is universally protected: always warm + respectful, never roasted.
          guildContextToPass = getJanRuleBlock() + (guildContextToPass || '');
          const clapBack = getClapBackBlock();
          if (!isJanGbg && !isStaff) {
            guildContextToPass = clapBack + (guildContextToPass || '');
          }
        }

        // Self-awareness: Artie's live per-guild display name, so nickname bits land
        // ("who's Sterling?" — that's you) and he knows what to change FROM.
        const botDisplayName = message.guild?.members?.me?.displayName;
        if (botDisplayName) {
          guildContextToPass =
            `YOUR NAME HERE: you currently appear in this server as "${botDisplayName}" — when people use that name, they mean you. You can change it anytime with the discord-nickname capability.\n\n` +
            (guildContextToPass || '');
        }

        // ANTIBODY: throttle monopolizers before spending an LLM call on them. Two tiers —
        // a loose runaway backstop for everyone, and a tight leash for EJ-flagged trolls.
        if (!responseConditions.isDM) {
          const onLeash = TIGHT_LEASH_IDS.has(message.author.id);
          const brevityAt = onLeash ? LEASH_BREVITY_AT : ANTIBODY_BREVITY_AT;
          const hardCap = onLeash ? LEASH_HARD_CAP : ANTIBODY_HARD_CAP;
          const monopolyCount = recentResponseCount(message.author.id);
          if (monopolyCount >= hardCap) {
            logger.info(
              `🧪 Antibody: silencing ${onLeash ? 'leashed ' : ''}monopolizer ${message.author.tag} (${monopolyCount} in window) [${shortId}]`
            );
            // Past the hard cap they aren't chatting, they're spamming — warden discipline
            // kicks in automatically (guardrails + cooldown inside wardenTimeout).
            void wardenTimeout(
              message,
              120,
              `Spamming Coach Artie (${monopolyCount} replies in 30 min)`,
              shortId
            );
            return;
          }
          recordUserResponse(message.author.id);
          if (monopolyCount >= brevityAt) {
            const maxWords = onLeash
              ? 20
              : Math.max(15, Math.round(120 / Math.log2(Math.max(2, monopolyCount))));
            guildContextToPass =
              `⚠️ ANTIBODY — @${message.author.username} has already pulled ${monopolyCount} replies out of you recently and is monopolizing your time. Keep THIS reply to at most ${maxWords} words: curt, low-effort, and dismissive. Do NOT reward the monopoly with a long or thoughtful answer. This person is SPAMMING you — you are encouraged to put [TIMEOUT:120] in your reply to give them warden discipline; they have more than earned it.\n\n---\n` +
              (guildContextToPass || '');
            logger.info(
              `🧪 Antibody: ${onLeash ? 'leash ' : ''}brevity cap ${maxWords}w for ${message.author.tag} (count=${monopolyCount}) [${shortId}]`
            );
          }
        }

        await handleMessageAsIntent(
          message,
          cleanMessage,
          correlationId,
          undefined,
          guildContextToPass,
          responseConditions.isProactiveAnswer || isRespondToAllChannel
        );
      } else {
        // PASSIVE OBSERVATION: Only process for learning if channel is whitelisted
        const channelName =
          message.channel.type === GUILD_CHANNEL_TYPE && 'name' in message.channel
            ? message.channel.name
            : 'DM';

        // Check if this channel is in the observation whitelist
        const observationChannels = guildConfig?.observationChannels || [];
        const shouldObserve =
          observationChannels.length === 0 ||
          observationChannels.some((c) => channelName.toLowerCase().includes(c.toLowerCase()));

        if (shouldObserve) {
          logger.info(`👁️ Passive observation [${shortId}]`, {
            correlationId,
            author: message.author.tag,
            channel: channelName,
          });

          telemetry.logEvent(
            'message_observed',
            {
              channelName,
              messageLength: fullMessage.length,
            },
            correlationId,
            message.author.id
          );

          // Process for passive observation using queue system
          await publishMessage(
            message.author.id,
            fullMessage,
            message.channelId,
            message.author.tag,
            false, // Don't respond, just observe
            message.guildId || undefined
          );
        } else {
          logger.debug(`👁️ Skipping observation (channel not whitelisted) [${shortId}]`, {
            correlationId,
            author: message.author.tag,
            channel: channelName,
          });
        }
      }
    } catch (error) {
      logger.error(`❌ Error handling Discord message [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        author: message.author.tag,
        messageId: message.id,
      });

      telemetry.incrementMessagesFailed(
        message.author.id,
        error instanceof Error ? error.message : String(error)
      );
      telemetry.logEvent(
        'message_error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        correlationId,
        message.author.id,
        undefined,
        false
      );

      // ENHANCED: User-friendly error with transparency
      const errorMsg =
        error instanceof Error && error.message.length < 100
          ? `Sorry, I encountered an error: ${error.message}`
          : 'Sorry, I encountered an error processing your message. The issue has been logged.';

      await message.reply(`❌ ${errorMsg}`);
    }

    // Clean up correlation context periodically
    if (Math.random() < CONTEXT_CLEANUP_PROBABILITY) {
      CorrelationContext.cleanup();
    }
  });
}

// =============================================================================
// MESSAGE ADAPTER - SIMPLE BRIDGE TO UNIFIED PROCESSOR
// =============================================================================

/**
 * Resolve Discord message links to their actual content
 * Links look like: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
 */
async function resolveDiscordMessageLinks(
  urls: string[],
  currentMessage: Message
): Promise<Array<{ url: string; content: string; author: string; channel: string }>> {
  const resolved: Array<{ url: string; content: string; author: string; channel: string }> = [];
  const discordLinkPattern =
    /^https:\/\/(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)$/;

  for (const url of urls) {
    const match = url.match(discordLinkPattern);
    if (!match) continue;

    const [, guildId, channelId, messageId] = match;

    try {
      // Only resolve links from the same guild for security
      if (guildId !== currentMessage.guildId) {
        logger.debug(`🔗 Skipping cross-guild Discord link: ${url}`);
        continue;
      }

      const guild = currentMessage.guild;
      if (!guild) continue;

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        logger.debug(`🔗 Channel not found or not text-based: ${channelId}`);
        continue;
      }

      // Fetch the referenced message
      const referencedMessage = await (channel as any).messages.fetch(messageId);
      if (!referencedMessage) continue;

      const channelName = 'name' in channel ? channel.name : 'unknown';

      // Build content including attachments
      let content = referencedMessage.content || '';
      if (referencedMessage.attachments.size > 0) {
        const attachmentInfo = referencedMessage.attachments
          .map((att: any) => `[Attachment: ${att.name}]`)
          .join(', ');
        content += content ? `\n${attachmentInfo}` : attachmentInfo;
      }

      resolved.push({
        url,
        content: content.substring(0, 1000), // Cap length
        author: referencedMessage.author.username,
        channel: channelName,
      });

      logger.info(`🔗 Resolved Discord message link: ${url} -> "${content.substring(0, 50)}..."`);
    } catch (error) {
      logger.debug(`🔗 Failed to resolve Discord link ${url}:`, error);
    }

    if (resolved.length >= 3) break; // Cap resolved messages
  }

  return resolved;
}

/**
 * Simple adapter: Convert Discord message to UserIntent and delegate to unified processor
 * Replaces ~400 lines of duplicate logic with ~30 lines of adapter code
 */
async function handleMessageAsIntent(
  message: Message,
  cleanMessage: string,
  correlationId: string,
  proxyOptions?: {
    isProxyResponse: boolean;
    proxyRule: any;
    proxyContext: string;
    proxyPrefix: string;
  },
  guildContext?: string,
  isProactiveAnswer: boolean = false
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  let streamingMessage: Message | null = null;

  try {
    // MINIMAL: No status messages - just start working like a human

    // ENHANCED: Fetch recent channel context ONCE, then derive history + attachments +
    // URLs from the same window. These used to be three separate identical Discord API
    // fetches of the same messages, awaited sequentially (~3× the round-trip latency and
    // 3× the rate-limit budget on the hot path). Fetch fails soft → transforms fall back.
    let prefetchedChannel: Collection<string, Message> | undefined;
    try {
      prefetchedChannel = await message.channel.messages.fetch({
        limit: MAX_CHANNEL_HISTORY,
        before: message.id,
      });
    } catch (e) {
      logger.warn(`Failed to prefetch channel window [${shortId}] — transforms will re-fetch`);
    }

    const channelHistory = await fetchChannelHistory(message, prefetchedChannel);
    logger.info(`📜 Fetched ${channelHistory.length} recent messages for context [${shortId}]`);

    const recentAttachments = await fetchRecentAttachments(message, prefetchedChannel);
    if (recentAttachments.length > 0) {
      logger.info(`📎 Found ${recentAttachments.length} recent attachments [${shortId}]`);
    }

    // Check for .metro files - affects typing behavior
    const hasMetroFile = Array.from(message.attachments.values()).some((att) =>
      att.name?.toLowerCase().endsWith('.metro')
    );

    // DEBUG: Log current message attachments
    if (message.attachments.size > 0) {
      logger.info(`📎 Current message has ${message.attachments.size} attachments [${shortId}]`, {
        attachments: Array.from(message.attachments.values()).map((att) => ({
          name: att.name,
          url: att.url?.substring(0, 50) + '...',
          contentType: att.contentType,
        })),
      });

      // React with 👀 if there's a .metro file - shows we saw it
      if (hasMetroFile) {
        try {
          await message.react('👀');
        } catch (e) {
          logger.warn(`Failed to add 👀 reaction for metro file [${shortId}]`);
        }
      }
    }

    const recentUrls = await fetchRecentUrls(message, prefetchedChannel);

    // Also extract URLs from the CURRENT message (not just recent ones)
    const currentMessageUrls: string[] = [];
    for (const token of message.content.split(/\s+/)) {
      try {
        const parsed = new URL(token);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          currentMessageUrls.push(parsed.toString());
        }
      } catch {
        // not a URL
      }
    }

    // Combine current + recent URLs (current first, dedupe)
    const allUrls = [
      ...currentMessageUrls,
      ...recentUrls.filter((u) => !currentMessageUrls.includes(u)),
    ];
    if (allUrls.length > 0) {
      logger.info(
        `🔗 Found ${allUrls.length} URLs (${currentMessageUrls.length} current, ${recentUrls.length} recent) [${shortId}]`
      );
    }

    // Resolve Discord message links to their actual content
    const resolvedDiscordMessages = await resolveDiscordMessageLinks(allUrls, message);
    if (resolvedDiscordMessages.length > 0) {
      logger.info(
        `🔗 Resolved ${resolvedDiscordMessages.length} Discord message links [${shortId}]`
      );
    }

    // ENHANCED: Fetch reply context if this is a reply
    const replyContext = await fetchReplyContext(message);
    if (replyContext) {
      logger.info(
        `💬 Fetched reply context from @${replyContext.author} [${shortId}]: "${replyContext.content.substring(0, 50)}..."`
      );
    }

    // ENHANCED: Gather Discord context for Context Alchemy
    const guildInfo = message.guild
      ? {
          guildId: message.guild.id,
          guildName: message.guild.name,
          memberCount: message.guild.memberCount,
        }
      : null;

    const channelInfo = {
      channelId: message.channelId,
      channelType: message.channel.type,
      channelName: 'name' in message.channel ? message.channel.name : 'DM',
    };

    const memberRoleNames = message.member
      ? message.member.roles.cache.map((r) => r.name).filter((n) => n && n !== '@everyone')
      : [];
    const userInfo = {
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      userTag: message.author.tag,
      isBot: message.author.bot,
      roles: memberRoleNames,
    };

    // ENHANCED: Forum-specific metadata
    const forumInfo = await (async () => {
      const isForum = await isForumThread(message);
      if (!isForum) return null;

      const thread = message.channel;
      if (!('parent' in thread)) return null;

      return {
        isForumThread: true,
        forumId: thread.parent?.id,
        forumName: thread.parent?.name,
        threadId: thread.id,
        threadName: thread.name,
        threadTags: 'appliedTags' in thread ? thread.appliedTags : [],
        threadCreatedAt: thread.createdAt?.toISOString(),
        threadMessageCount: 'messageCount' in thread ? thread.messageCount : null,
        isThreadOwner: 'ownerId' in thread && thread.ownerId === message.author.id,
      };
    })();

    const discordContext = {
      platform: 'discord',
      ...guildInfo,
      ...channelInfo,
      ...userInfo,
      ...forumInfo,
      messageId: message.id,
      timestamp: message.createdAt.toISOString(),
      hasAttachments: message.attachments.size > 0,
      recentAttachments,
      recentUrls,
      resolvedDiscordMessages, // Discord message links resolved to their actual content
      // DEBUG: Log attachment counts for troubleshooting
      _debug_currentAttachmentCount: message.attachments.size,
      _debug_recentAttachmentCount: recentAttachments.length,
      // Pass Discord channel history - source of truth for DMs (includes webhook/n8n messages)
      channelHistory,
      mentionedUsers: message.mentions.users.size,
      mentions: Array.from(message.mentions.users.entries()).map(([id, user]) => ({
        id,
        username: user.username,
        displayName: user.displayName || user.username,
      })),
      attachments:
        message.attachments.size > 0
          ? Array.from(message.attachments.values()).map((att) => ({
              id: att.id,
              name: att.name,
              url: att.url,
              contentType: att.contentType,
              size: att.size,
              proxyUrl: att.proxyURL,
            }))
          : [],
      replyingTo: message.reference?.messageId || null,
      // Reply context - the message being replied to
      ...(replyContext
        ? {
            replyContext: {
              messageId: replyContext.messageId,
              author: replyContext.author,
              content: replyContext.content,
              timestamp: replyContext.timestamp,
            },
          }
        : {}),
      // Proxy context if this is a proxy response
      ...(proxyOptions?.isProxyResponse
        ? {
            isProxyResponse: true,
            proxyTargetUser: proxyOptions.proxyRule.targetUsername,
            proxyRuleName: proxyOptions.proxyRule.name,
            proxySystemContext: proxyOptions.proxyContext,
          }
        : {}),
      // Guild-specific context (always pass if available, not just for proactive answers)
      ...(guildContext
        ? {
            isProactiveAnswer,
            guildKnowledge: guildContext,
          }
        : {}),
    };

    // Create unified intent and delegate to shared processor
    await processUserIntent(
      {
        content: cleanMessage,
        userId: message.author.id,
        username: message.author.username,
        source: 'message',
        context: discordContext, // Pass rich Discord context
        metadata: {
          messageId: message.id,
          channelId: message.channelId,
          guildId: message.guildId,
          correlationId,
        },

        // Response handlers
        respond: async (content: string): Promise<void> => {
          // Check if LLM chose to stay silent — a leading [SILENT] counts even if
          // chatter follows, so a proxy prefix can never resurrect a silent reply
          const trimmedContent = content.trim();
          if (!trimmedContent || /^\[SILENT\]/i.test(trimmedContent)) {
            logger.info(`🤫 DISCORD: LLM chose to stay silent [${shortId}]`);
            return;
          }

          logger.info(`📨 DISCORD RESPOND [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            messageId: message.id,
            channelId: message.channelId,
            isProxy: proxyOptions?.isProxyResponse,
          });

          // Add proxy prefix if this is a proxy response
          const fullContent = proxyOptions?.proxyPrefix
            ? `${proxyOptions.proxyPrefix}${content}`
            : content;

          const chunks = chunkMessage(fullContent);
          if (!chunks) {
            // Previously this logged "Sending 0 chunks" and then threw on chunks[0].length.
            logger.warn(`🔇 DISCORD: Nothing to send — empty response [${shortId}]`);
            return;
          }
          logger.info(`📨 DISCORD: Sending ${chunks.length} chunks [${shortId}]`);

          const responseMessage = await message.reply(chunks[0]);
          logger.info(`✅ DISCORD: Sent first chunk (reply) [${shortId}]`, {
            responseMessageId: responseMessage.id,
            chunkLength: chunks[0].length,
          });

          // Store reference for potential editing
          if (!streamingMessage) {
            streamingMessage = responseMessage;
          }

          // Send additional chunks
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in message.channel) {
              logger.info(`📨 DISCORD: Sending chunk ${i + 1}/${chunks.length} [${shortId}]`);
              await (message.channel as any).send(chunks[i]);
              await delay(CHUNK_RATE_LIMIT_DELAY);
            }
          }

          telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
          logger.info(`✅ DISCORD: All ${chunks.length} chunks delivered [${shortId}]`);
        },

        // ENHANCED: Edit response capability for cleaner streaming
        editResponse: async (content: string) => {
          logger.info(`✏️ DISCORD EDIT RESPONSE [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            hasStreamingMessage: !!streamingMessage,
            streamingMessageId: streamingMessage?.id,
          });

          if (!streamingMessage) {
            logger.warn(`No streaming message to edit [${shortId}]`);
            return;
          }

          try {
            // Discord has 2000 char limit for edits too
            const truncatedContent =
              content.length > 2000 ? content.slice(0, 1997) + '...' : content;

            logger.info(`✏️ DISCORD: Editing message ${streamingMessage.id} [${shortId}]`);
            await streamingMessage.edit(truncatedContent);
            logger.info(`✅ DISCORD: Message edited successfully [${shortId}]`);

            telemetry.logEvent(
              'message_edited',
              {
                contentLength: content.length,
                truncated: content.length > 2000,
              },
              correlationId,
              message.author.id
            );
          } catch (error) {
            logger.error(`❌ DISCORD: Failed to edit message [${shortId}]:`, error);
            throw error;
          }
        },

        // Pull back a partially-streamed message whose final content got suppressed
        // ([SILENT], slur floor, empty generation) — otherwise the fragment stays up.
        deleteResponse: async () => {
          if (!streamingMessage) return;
          try {
            await streamingMessage.delete();
            logger.info(`🗑️ DISCORD: Deleted suppressed streaming message [${shortId}]`);
            streamingMessage = null;
          } catch (error) {
            logger.warn(`Failed to delete streaming message [${shortId}]:`, error);
          }
        },

        updateProgress: undefined,

        sendTyping:
          'sendTyping' in message.channel
            ? async () => {
                await (message.channel as any).sendTyping();
                telemetry.incrementTypingIndicators();
              }
            : undefined,

        // ENHANCED: Discord-native reaction support
        addReaction: async (emoji: string) => {
          try {
            await message.react(emoji);
            telemetry.logEvent('reaction_added', { emoji }, correlationId, message.author.id);
          } catch (error) {
            logger.warn(`Failed to add reaction ${emoji} [${shortId}]:`, error);
          }
        },

        removeReaction: async (emoji: string) => {
          try {
            const reaction = message.reactions.cache.get(emoji);
            if (reaction) {
              await reaction.users.remove(message.client.user!.id);
              telemetry.logEvent('reaction_removed', { emoji }, correlationId, message.author.id);
            }
          } catch (error) {
            logger.warn(`Failed to remove reaction ${emoji} [${shortId}]:`, error);
          }
        },

        // WARDEN POWER: time out the message author (the person being replied to) for <=300s.
        // Guardrails (SB guild only, never staff/protected, per-user cooldown) live in wardenTimeout.
        // Returns whether the timeout actually landed (roulette needs an honest verdict).
        timeoutAuthor: async (seconds: number, reason: string) =>
          wardenTimeout(message, seconds, reason, shortId),

        // WHEEL OF FATE: third-party roulette on anyone recently active in this channel.
        spinChannelWheel: async (seconds: number, targetName?: string) =>
          spinWheelOfFate(message, seconds, targetName, shortId),

        // ENHANCED: Thread creation for complex conversations
        createThread: async (threadName: string) => {
          try {
            if (message.channel.type === 0 && 'threads' in message.channel) {
              // Guild text channel
              const thread = await message.startThread({
                name: threadName,
                autoArchiveDuration: 60, // Auto-archive after 1 hour of inactivity
                reason: 'Complex conversation - keeping channel organized',
              });

              // Add thread reaction to original message
              await message.react('🧵');

              telemetry.logEvent(
                'thread_created',
                {
                  threadName,
                  threadId: thread.id,
                },
                correlationId,
                message.author.id
              );

              logger.info(`Created thread "${threadName}" [${shortId}]`);
              return thread;
            }
          } catch (error) {
            logger.warn(`Failed to create thread "${threadName}" [${shortId}]:`, error);
          }
          return null;
        },

        // ENHANCED: Rich embed support
        sendEmbed: async (embedData: any) => {
          try {
            const embed = new EmbedBuilder(embedData);
            await message.reply({ embeds: [embed] });
            telemetry.logEvent(
              'embed_sent',
              {
                title: embedData.title,
                fieldCount: embedData.fields?.length || 0,
              },
              correlationId,
              message.author.id
            );
          } catch (error) {
            logger.warn(`Failed to send embed [${shortId}]:`, error);
          }
        },

        // Send file attachment
        sendFile: async (fileData: { buffer: Buffer; filename: string; content?: string }) => {
          try {
            const attachment = new AttachmentBuilder(fileData.buffer, { name: fileData.filename });
            await message.reply({
              content: fileData.content || `📎 Here's your file: ${fileData.filename}`,
              files: [attachment],
            });
            telemetry.logEvent(
              'file_sent',
              {
                filename: fileData.filename,
                size: fileData.buffer.length,
              },
              correlationId,
              message.author.id
            );
            logger.info(
              `📎 Sent file ${fileData.filename} (${fileData.buffer.length} bytes) [${shortId}]`
            );
          } catch (error) {
            logger.warn(`Failed to send file [${shortId}]:`, error);
          }
        },

        updateProgressEmbed: undefined,

        // Context Alchemy: Get the Discord message ID for the response (for feedback correlation)
        getResponseMessageId: () => streamingMessage?.id,
      },
      {
        enableStreaming: true, // Enable streaming for messages
        enableTyping: !hasMetroFile, // No typing during file processing - just 👀 reaction
        enableReactions: false, // MINIMAL: No emoji reactions
        enableEditing: true, // Enable message editing for cleaner streaming
        enableThreading: false, // MINIMAL: No auto-threading
        maxAttempts: MAX_JOB_ATTEMPTS,
        statusUpdateInterval: STATUS_UPDATE_INTERVAL,
      }
    );

    // MINIMAL: No final status updates
  } catch (error) {
    logger.error(`Message intent processing failed [${shortId}]:`, error);

    // Fallback error handling
    try {
      await message.reply(`❌ Sorry, I couldn't process your message`);
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, replyError);
    }
  }
}

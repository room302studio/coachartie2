/**
 * on-message: the ONE MessageCreate listener.
 *
 * Every incoming Discord message runs the ordered STEPS at the bottom of this file. A step
 * returns 'stop' to end the turn there; anything else moves on to the next step. Steps share
 * one Turn record (what earlier steps learned about the message). The heavy pieces live next
 * door: 2-gate/ambient.ts (unaddressed-message judgment, cooldowns, ambient budget),
 * 2-gate/pacing.ts (burst guard, antibody), 1-receive/guild-context.ts (persona and rule
 * blocks), 1-receive/expand-links.ts, 3-ask-engine/build-request.ts (Discord message → turn
 * request) and 4-reply/discord-reply.ts (delivery hooks, warden powers).
 *
 * Split out of the old 2,539-line message-handler.ts in wave 5, behavior-neutral: every step
 * body is the old listener's code moved verbatim, in the old order.
 */

import { Client, Events, Message, ChannelType } from 'discord.js';
import { checkGuildBudget, reportGuildBudgetSpent } from '../../shared/guild-budget.js';
import { logger } from '../../shared/logger.js';
import { canDMForTasks, getDMPolicy, isOwner } from '../../shared/config/owner.js';
import { dmPairingService, logDMGate } from '../../shared/dm-pairing.js';
import { reportToAnomalywatch } from '../../shared/anomalywatch.js';
import { BLOCKED_USER_IDS, isBlockedUser } from '../../shared/blocklist.js';
import { isOperatorOnlyError } from '../../shared/anomalywatch.js';
import { getKillSwitchPath, isGenerationMuted } from '../../shared/kill-switch.js';
import { getStrikeMode } from '../../shared/paths.js';
import { decideSpeakRoute, runSpeakGate, resolveAmbientMode, isReplyToBot } from '../2-gate/speak-gate.js';
import { publishMessage } from '../../shared/queue/discord-publisher.js';
import { telemetry } from '../telemetry.js';
import { CorrelationContext, getShortCorrelationId } from '../correlation.js';
import {
  isGuildWhitelisted,
  isWorkingGuild,
  getGuildConfig,
  getChannelPersona,
  shouldRespondToAllInChannel,
  isChannelAllowedForResponse,
  type ChannelPersona,
  type GuildConfig,
} from '../../shared/config/guilds.js';
import { isForumThread, isRobotChannelName, GUILD_CHANNEL_TYPE } from './channel-history.js';
import { buildReplyGuildContext } from './guild-context.js';
import { handleGitHubAutoExpansion } from './expand-links.js';
import {
  getGitHubIntegrationSafe,
  isGitHubIntegrationReady,
} from '../watchers/github/issue-sync.js';
import { checkOutbound } from '../4-reply/outbound-gate.js';
import { maybeAmbientReact, reactToBlockedUser } from '../4-reply/ambient-reactions.js';
import {
  AMBIENT_RESPONSE_HOURLY_CAP,
  checkProactiveAnswer,
  getAmbientResponseCount,
  isAmbientBudgetExhausted,
  markRespondToAllCooldown,
  recordAmbientResponse,
  shouldProactivelyAnswer,
  throttleRespondToAll,
  type ResponseConditions,
} from '../2-gate/ambient.js';
import { applyAntibody, isBurstRepeat } from '../2-gate/pacing.js';
import { runMentionProxy } from '../2-gate/mention-proxy.js';
import { handleMessageAsIntent } from '../3-ask-engine/build-request.js';
import { handleQuizAnswer } from '../commands/quiz/command.js';
import { existsSync, unlinkSync } from 'fs';

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1% chance to cleanup correlation context

// EMERGENCY KILL SWITCH — global mute. If this file exists, Artie ignores ALL messages.
// `touch <repo>/KILL_SWITCH` to silence instantly (no restart); `rm` to revive.
// Toggle remotely via POST /api/killswitch {"enabled":true|false}.
// Also set automatically by the daily spend cap (capabilities daily-budget.ts).
const KILL_SWITCH_PATH = getKillSwitchPath();

// =============================================================================
// THE TURN: what the steps have learned about one incoming message
// =============================================================================

type StepResult = 'stop' | void;
type Step = (turn: Turn) => StepResult | Promise<StepResult>;

interface Turn {
  readonly message: Message;
  readonly client: Client;
  readonly correlationId: string;
  readonly shortId: string;
  /** checkOutbound('reply') verdict: routing, not policy (every action re-checks the gate). */
  isCoachArtiePlace: boolean;
  /** The strike ended on this very message; the speak gate treats that as ambient. */
  strikeJustLifted: boolean;
  guildConfig: GuildConfig | null;
  responseConditions: ResponseConditions;
  proactiveAnswerContext: string | undefined;
  channelName: string;
  channelPersona: ChannelPersona | null;
  isRespondToAllChannel: boolean;
  isDMAllowed: boolean;
  explicitlyAddressed: boolean;
  shouldRespond: boolean;
}

function startTurn(message: Message, client: Client): Turn {
  // -------------------------------------------------------------------------
  // CORRELATION & LOGGING SETUP
  // -------------------------------------------------------------------------

  const correlationId = CorrelationContext.getForMessage(message.id);
  const shortId = getShortCorrelationId(correlationId);
  return {
    message,
    client,
    correlationId,
    shortId,
    isCoachArtiePlace: false,
    strikeJustLifted: false,
    guildConfig: null,
    responseConditions: {
      botMentioned: false,
      repliedToBot: false,
      isDM: false,
      isRobotChannel: false,
      isForumThread: false,
      isProactiveAnswer: false,
    },
    proactiveAnswerContext: undefined,
    channelName: '',
    channelPersona: null,
    isRespondToAllChannel: false,
    isDMAllowed: false,
    explicitlyAddressed: false,
    shouldRespond: false,
  };
}

// =============================================================================
// STEPS, in the order they run (see STEPS below)
// =============================================================================

function logReceived({ message, correlationId, shortId }: Turn): StepResult {
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
}

// -------------------------------------------------------------------------
// RESPONSE CONDITION DETECTION
// -------------------------------------------------------------------------

function ignoreOwnMessages({ message, client }: Turn): StepResult {
  // Ignore our own messages to prevent loops
  if (message.author.id === client.user!.id) return 'stop';
}

function resolveCoachArtiePlace(turn: Turn): StepResult {
  // COACH-ARTIE CHANNELS ONLY: in the public Subway Builder guild, Artie is only visibly
  // active (replies AND reactions) in robot / coach-artie channels or channels with a
  // persona like Judge Artie. The invariant itself lives in outbound-gate.ts — every
  // action path re-checks the gate itself, so this flow variable is routing, not policy.
  turn.isCoachArtiePlace = checkOutbound('reply', turn.message).allowed;
}

// Hard ban: users who get NO response from Artie at all (dropped before any processing).
// EJ-curated. Supersedes the tight-leash list. The list itself lives in
// shared/blocklist.ts because the engine enforces it too:
// blocked users are also stripped from channel-history context, reply context,
// observational learning, and memory formation/recall — Artie shouldn't even
// mention them.
function dropBlockedUser({ message }: Turn): StepResult {
  // Hard ban: users banned from using Artie entirely. Dropped before any processing —
  // no response, no LLM call, no cost. (EJ-curated.) In coach-artie channels they get a
  // rate-limited 💔 so poking the bot isn't a confusing void; everywhere else, nothing —
  // 💔-ing someone's normal chat in normal channels reads as harassment, not moderation.
  if (BLOCKED_USER_IDS.has(message.author.id)) {
    reactToBlockedUser(message);
    return 'stop';
  }
}

function dropOptedOut({ message }: Turn): StepResult {
  // Privacy opt-out (/artie-optout): their own choice, so no 💔 — Artie just doesn't read,
  // store, or answer their messages. /artie-optin (an interaction, not a message) undoes it.
  if (isBlockedUser(message.author.id)) {
    return 'stop';
  }
}

function requireCoachArtiePlace({ message, shortId, isCoachArtiePlace }: Turn): StepResult {
  // EMERGENCY KILL SWITCH — checked per message, no restart required.
  if (!isCoachArtiePlace) {
    const _chName = ('name' in message.channel ? message.channel.name : '') || '';
    logger.info(`Non-Coach-Artie channel #${_chName} - not responding [${shortId}]`);
    return 'stop';
  }
}

function ambientReaction({ message }: Turn): StepResult {
  // Roll for a free, wordless reaction. Independent of whether he ends up replying — the
  // point is presence without barging in, and it costs no tokens. Must stay BELOW the
  // channel gate: above it he was reacting to random people in every channel guild-wide.
  maybeAmbientReact(message);
}

function strikeMode(turn: Turn): StepResult {
  const { message, shortId } = turn;
  // SELF-IMPOSED STRIKE: Artie refuses to speak until someone defends Subway Builder.
  const STRIKE_PATH = getStrikeMode();
  if (existsSync(STRIKE_PATH) && message.guildId === '1420846272545296470' && !message.author.bot) {
    const _defends =
      /subway ?builder|this game|the game/i.test(message.content) &&
      /love|great|amazing|best|awesome|defend|incredible|\bfun\b|masterpiece|goated|peak|\brules\b|\bsick\b|fire|good game|\bgg\b|underrated|carries/i.test(message.content);
    if (_defends) {
      try { unlinkSync(STRIKE_PATH); } catch { /* ignore */ }
      turn.strikeJustLifted = true;
      logger.info(`Strike lifted - ${message.author.tag} defended Subway Builder [${shortId}]`);
    } else {
      logger.info(`On strike - staying silent [${shortId}]`);
      return 'stop';
    }
  }
}

function killSwitch({ shortId }: Turn): StepResult {
  if (isGenerationMuted(KILL_SWITCH_PATH)) {
    logger.warn(`🛑 KILL SWITCH active — ignoring message [${shortId}]`);
    return 'stop';
  }
}

function guildBudgetShare({ message, shortId }: Turn): StepResult {
  // Per-guild share of the daily budget (shared guild-budget.ts): once a guild's share is
  // spent, stay silent there for the rest of the ET day. Other guilds and DMs unaffected.
  const guildBudget = checkGuildBudget(message.guildId);
  if (guildBudget?.over) {
    reportGuildBudgetSpent(guildBudget);
    logger.warn(
      `💸 Guild budget share spent ($${guildBudget.spentUsd.toFixed(2)}/$${guildBudget.capUsd.toFixed(2)}) — silent in ${message.guildId} [${shortId}]`
    );
    return 'stop';
  }
}

async function capturePresenceReply({ message }: Turn): Promise<StepResult> {
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
}

async function quizAnswer({ message }: Turn): Promise<StepResult> {
  // Body: commands/quiz/command.ts handleQuizAnswer.
  if (await handleQuizAnswer(message)) return 'stop';
}

function guildWhitelist({ message, shortId }: Turn): StepResult {
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
    return 'stop';
  }
}

async function githubAutoExpansion({ message, correlationId, shortId }: Turn): Promise<StepResult> {
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
          return 'stop'; // Don't process message further - auto-expansion handled it
        }
      }
    } catch (error) {
      // Log error but continue with normal message processing
      logger.warn(`GitHub auto-expansion failed [${shortId}]:`, error);
    }
  }
}

async function mentionProxy({ message, client, correlationId, shortId }: Turn): Promise<StepResult> {
  // Body: 2-gate/mention-proxy.ts runMentionProxy (errors there are logged and swallowed).
  if (await runMentionProxy(message, client, correlationId, shortId)) return 'stop';
}

async function detectResponseConditions(turn: Turn): Promise<StepResult> {
  const { message, client } = turn;
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

  // A Discord reply to one of Artie's messages addresses him even without a ping (#88).
  const repliedToBot = !isDirectBotMention && (await isReplyToBot(message, client.user!.id));

  const responseConditions = {
    botMentioned: isDirectBotMention,
    repliedToBot,
    isDM: message.channel.isDMBased(),
    isRobotChannel: isRobotChannelName(message.channel),
    isForumThread: isForum,
    isProactiveAnswer: false, // Will be set below if applicable
  };
  turn.guildConfig = guildConfig;
  turn.responseConditions = responseConditions;
}

async function proactiveAnswer(turn: Turn): Promise<StepResult> {
  const { message, client, guildConfig, responseConditions, correlationId, shortId } = turn;
  turn.proactiveAnswerContext = await checkProactiveAnswer(
    message,
    client,
    guildConfig,
    responseConditions,
    correlationId,
    shortId
  );
}

function resolveChannelPersona(turn: Turn): StepResult {
  const { message, responseConditions, shortId } = turn;
  // Determine response mode: active response vs passive observation
  // In forums, only respond when mentioned (too noisy otherwise)
  // In robot channels, skip replies to other users (not the bot) - they're having their own conversation
  const isReplyToOtherUser =
    message.reference && !responseConditions.botMentioned && !responseConditions.repliedToBot;

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

  isRespondToAllChannel = throttleRespondToAll(
    message,
    channelPersona,
    responseConditions,
    isRespondToAllChannel,
    shortId
  );

  if (isRespondToAllChannel && channelPersona) {
    logger.info(
      `⚖️ Channel persona active: ${channelPersona.personaName} in #${channelName} [${shortId}]`
    );
  }
  turn.channelName = channelName;
  turn.channelPersona = channelPersona;
  turn.isRespondToAllChannel = isRespondToAllChannel;
}

async function dmGate(turn: Turn): Promise<StepResult> {
  const { message, correlationId, shortId, responseConditions } = turn;
  // For DMs, check authorization via pairing system
  // OpenClaw-compatible: unknown users get pairing code
  const isDMFromAuthorizedUser = responseConditions.isDM && canDMForTasks(message.author.id);
  const dmWho = { userId: message.author.id, username: message.author.username };

  if (isDMFromAuthorizedUser) {
    logDMGate(isOwner(message.author.id) ? 'owner' : 'allowed', { ...dmWho, detail: `[${shortId}]` });
  }

  if (responseConditions.isDM && !isDMFromAuthorizedUser) {
    const policy = getDMPolicy('discord');

    if (policy.policy === 'open') {
      // Open mode: treat as authorized
      logDMGate('open', { ...dmWho, detail: `open policy [${shortId}]` });
    } else if (policy.policy === 'pairing') {
      // Pairing mode: send pairing code
      logDMGate('blocked_pairing', {
        ...dmWho,
        detail: `unverified, sent pairing code: "${message.content.slice(0, 80)}" [${shortId}]`,
      });

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

        // New request → EJ's phone via anomalywatch (EJ, 2026-09-29: "run it thru anomalywatch
        // at a high weight"). Its own alert_type scores 7.5 there: pages when awake, digest
        // when asleep. One per requester per ET day, so a stranger can't spam pages.
        if (isNew) {
          void reportToAnomalywatch(
            'warning',
            `DM pairing request: ${message.author.username} (${message.author.id}) wants to DM Artie: "${message.content.slice(0, 120)}". Approve with /pairing approve code:${code} (expires in ${expiresInMinutes}m)`,
            {
              kind: `dm-pairing:${message.author.id}`,
              alertType: 'dm_pairing_request',
              deepLink: `https://discord.com/users/${message.author.id}`,
            }
          );
        }
      } catch (error) {
        logger.error('Failed to send pairing code:', error);
      }

      return 'stop'; // Don't process the message further
    } else {
      // Closed mode: silent ignore (current behavior)
      logDMGate('blocked_closed', { ...dmWho, detail: `closed policy, ignored [${shortId}]` });
      return 'stop';
    }
  }

  // Check if DM should be processed (authorized OR open policy)
  const dmPolicy = responseConditions.isDM ? getDMPolicy('discord') : null;
  const isDMAllowed = isDMFromAuthorizedUser || (responseConditions.isDM && dmPolicy?.policy === 'open');
  turn.isDMAllowed = isDMAllowed;
}

async function speakGate(turn: Turn): Promise<StepResult> {
  const {
    message,
    correlationId,
    shortId,
    strikeJustLifted,
    guildConfig,
    responseConditions,
    channelName,
    channelPersona,
    isRespondToAllChannel,
    isDMAllowed,
  } = turn;
  // Explicit triggers: the user deliberately addressed the bot (@mention, reply, DM) —
  // always respond, regardless of channel whitelist or budget.
  // A message with no text and no attachments is what a no-ping reply to Artie looks like
  // without the MessageContent intent (index.ts). There's nothing to answer; don't pay for it.
  const hasReadableContent = message.content.trim().length > 0 || message.attachments.size > 0;
  const explicitlyAddressed =
    hasReadableContent &&
    (responseConditions.botMentioned || responseConditions.repliedToBot || isDMAllowed);

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

  // SPEAK GATE (#88/#89, services/speak-gate.ts): the persona model runs only when Artie was
  // addressed. Anything the routing above would answer unprompted — a proactive answer, a
  // respondToAll persona, the strike-lift bit — needs a YES from the cheap judgment first
  // (the proactive path already got one), and a judgment error means silence.
  const ambientCandidate = strikeJustLifted || (ambientAllowed && !ambientBudgetBlocked);
  const speakRoute = decideSpeakRoute({
    botMentioned: responseConditions.botMentioned,
    repliedToBot: responseConditions.repliedToBot,
    isDMAllowed,
    ambientCandidate,
    gateAlreadyPassed: responseConditions.isProactiveAnswer,
    ambientMode: resolveAmbientMode(guildConfig),
  });
  let shouldRespond =
    speakRoute.route === 'addressed' || speakRoute.route === 'ambient-approved';
  if (speakRoute.route === 'gate') {
    const gateContext = channelPersona?.systemPrompt || guildConfig?.context || '';
    shouldRespond = await runSpeakGate(() =>
      shouldProactivelyAnswer(message, gateContext, correlationId)
    );
    logger.info(
      `🤐 Speak gate (cheap judgment) → ${shouldRespond ? 'SPEAK' : 'stay quiet'} [${shortId}]`
    );
  } else if (speakRoute.route === 'silent' && ambientCandidate) {
    logger.info(`🤐 Unprompted reply suppressed — ${speakRoute.reason} [${shortId}]`);
  }
  turn.explicitlyAddressed = explicitlyAddressed;
  turn.shouldRespond = shouldRespond;
}

function emptyMention({ message, client, shortId, shouldRespond, responseConditions }: Turn): StepResult {
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
      return 'stop';
    }
  }
}

function burstGuard({ message, shortId, shouldRespond, responseConditions }: Turn): StepResult {
  // CONCURRENCY GUARD: throttle a single user's rapid-fire mentions so one spammer can't
  // trigger duplicate/parallel replies — but keyed PER USER so distinct people are still
  // answered (a per-channel key muted everyone when one person spammed). DMs exempt (1:1).
  if (shouldRespond && !responseConditions.isDM) {
    if (isBurstRepeat(message, shortId)) return 'stop';
  }
}

async function respondOrObserve(turn: Turn): Promise<StepResult> {
  const {
    message,
    client,
    correlationId,
    shortId,
    guildConfig,
    responseConditions,
    proactiveAnswerContext,
    channelPersona,
    isRespondToAllChannel,
    explicitlyAddressed,
    shouldRespond,
  } = turn;
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
      return 'stop';
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
        : responseConditions.repliedToBot
          ? 'reply'
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
          markRespondToAllCooldown(message.channelId);
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

      let guildContextToPass = buildReplyGuildContext(
        message,
        guildConfig,
        channelPersona,
        proactiveAnswerContext,
        shortId
      );

      // ANTIBODY: throttle monopolizers before spending an LLM call on them. Two tiers —
      // a loose runaway backstop for everyone, and a tight leash for EJ-flagged trolls.
      if (!responseConditions.isDM) {
        const verdict = applyAntibody(message, guildContextToPass, shortId);
        if (verdict.silenced) return 'stop';
        guildContextToPass = verdict.guildContext;
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

    // Billing / credits / budget / kill-switch failures are operator-only — never reply.
    if (isOperatorOnlyError(error)) {
      logger.warn(`🔇 Operator-only failure not echoed to channel [${shortId}]`);
      return 'stop';
    }

    // ENHANCED: User-friendly error with transparency
    const errorMsg =
      error instanceof Error && error.message.length < 100
        ? `Sorry, I encountered an error: ${error.message}`
        : 'Sorry, I encountered an error processing your message. The issue has been logged.';

    await message.reply(`❌ ${errorMsg}`);
  }
}

function cleanupCorrelation(): StepResult {
  // Clean up correlation context periodically
  if (Math.random() < CONTEXT_CLEANUP_PROBABILITY) {
    CorrelationContext.cleanup();
  }
}

// =============================================================================
// THE LISTENER
// =============================================================================

const STEPS: ReadonlyArray<readonly [name: string, step: Step]> = [
  ['log-received', logReceived],
  ['ignore-own-messages', ignoreOwnMessages],
  ['coach-artie-place', resolveCoachArtiePlace],
  ['blocked-user', dropBlockedUser],
  ['opted-out', dropOptedOut],
  ['require-coach-artie-place', requireCoachArtiePlace],
  ['ambient-reaction', ambientReaction],
  ['strike-mode', strikeMode],
  ['kill-switch', killSwitch],
  ['guild-budget', guildBudgetShare],
  ['presence-reply', capturePresenceReply],
  ['quiz-answer', quizAnswer],
  ['guild-whitelist', guildWhitelist],
  ['github-auto-expansion', githubAutoExpansion],
  ['mention-proxy', mentionProxy],
  ['response-conditions', detectResponseConditions],
  ['proactive-answer', proactiveAnswer],
  ['channel-persona', resolveChannelPersona],
  ['dm-gate', dmGate],
  ['speak-gate', speakGate],
  ['empty-mention', emptyMention],
  ['burst-guard', burstGuard],
  ['respond-or-observe', respondOrObserve],
  ['cleanup-correlation', cleanupCorrelation],
];

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
    const turn = startTurn(message, client);
    for (const [, step] of STEPS) {
      // A synchronous step's result is used as-is (no await), so the sync prefix of a turn
      // stays one uninterrupted run, exactly like the old single-function listener.
      const result = step(turn);
      if ((result instanceof Promise ? await result : result) === 'stop') return;
    }
  });
}

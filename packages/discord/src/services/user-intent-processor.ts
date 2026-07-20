/**
 * Universal User Intent Processor
 *
 * Single implementation for all Discord interactions:
 * - Messages, button clicks, menu selections, slash commands
 * - Handles job submission, monitoring, streaming, completion
 * - Provides consistent UX across all interaction types
 */

import { logger, scrubBlockedUserMentions } from '@coachartie/shared';
import { capabilitiesClient } from './capabilities-client.js';
import {
  recordSelfSpin,
  adjustCred,
  recordTableServed,
  bjDeal,
  bjHit,
  bjStand,
  bjFmt,
  spinSlots,
  bumpHouseEvents,
  houseFlourish,
} from './casino.js';

/** Attach the house's deteriorating inner monologue to a verdict (Discord small-text). */
function withMelt(verdict: string): string {
  const aside = houseFlourish();
  return aside ? `${verdict}\n-# ${aside}` : verdict;
}
import { jobMonitor } from './job-monitor.js';
import { telemetry } from './telemetry.js';
import { generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';

// OUTPUT SAFETY FLOOR: genuine slurs / hate terms that must NEVER reach a channel, even in
// roast mode. If a reply matches, the message is suppressed (Artie stays silent) rather than
// posted. Word-boundaried + case-insensitive. Profanity is intentionally NOT here — roasts can
// swear; this is only the "bad ones."
const OUTPUT_SLUR_BLOCKLIST =
  /\b(n[i1]gg(?:er|a|ah)|f[a4]gg?(?:ot|y)?|retard(?:ed|s)?|k[i1]ke|sp[i1]c|ch[i1]nk|g[o0]ok|tr[a4]nny|wetback|coon|beaner|dyke|sand[\s-]?n[i1]gg|porch[\s-]?monkey)\b/i;

// OUTPUT SAFETY: never let prompt scaffolding / internal context leak into a channel message.
// (He once dumped "Pinned memory:", his instruction text, and the [CURRENT MESSAGE] wrapper.)
const INTERNAL_LEAK_BLOCKLIST =
  /\[CURRENT MESSAGE\]|Remember:\s*You are Coach Artie|Pinned memory:|Don.?t echo any XML|\(ID:\s*\d{5,}\)|<\/?capability\b|<calc\b/i;

/**
 * Shared output safety floor for anything Artie posts OUTSIDE the normal reply
 * pipeline (e.g. scheduled launch-countdown posts). Same rule as replies:
 * a match means suppress the message entirely, never post a censored version.
 */
export function violatesOutputSafety(text: string): boolean {
  return OUTPUT_SLUR_BLOCKLIST.test(text) || INTERNAL_LEAK_BLOCKLIST.test(text);
}

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
  timeoutAuthor?: (seconds: number, reason: string) => Promise<boolean>;
  spinChannelWheel?: (
    seconds: number,
    targetName?: string
  ) => Promise<{ target: string | null; roll: number; boxed: boolean; landed: boolean; stake: number }>;
  deleteResponse?: () => Promise<void>;
  editResponse?: (content: string) => Promise<void>;
  createThread?: (name: string) => Promise<any>;
  sendEmbed?: (embed: any) => Promise<void>;
  updateProgressEmbed?: (embed: any) => Promise<void>;
  sendFile?: (fileData: { buffer: Buffer; filename: string; content?: string }) => Promise<void>;
  // Context Alchemy: Get the Discord message ID for the response (for feedback correlation)
  getResponseMessageId?: () => string | undefined;
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
 * Strip LLM system/capability tags that should never reach Discord.
 * The LLM sometimes emits these despite prompting — belt and suspenders.
 */
function cleanCapabilityTags(text: string): string {
  return text
    .replace(/<capability\b[^>]*\/>/gs, '')
    .replace(/<capability\b[^>]*>[\s\S]*?<\/capability>/gs, '')
    .replace(/<wants_loop>[^<]*<\/wants_loop>/gs, '')
    .replace(/<think>[\s\S]*?<\/think>/gs, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gs, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Determine if content warrants a thread
 * Simple heuristic: long messages or multiple questions get threads
 */
function shouldCreateThread(content: string): boolean {
  // Create threads for long requests or multiple questions
  // No keyword heuristics - just length-based
  return content.length > 200 || content.split('?').length > 2;
}

/**
 * Generate a friendly thread name from content
 * Simple approach: first few words
 */
function generateThreadName(content: string): string {
  // Just use first few words - no keyword heuristics
  const truncated = content.slice(0, 80);
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
  const reactedEmojis = new Set<string>(); // Track capability emojis already reacted with
  let discordMessageLinked = false; // Context Alchemy: Track if we've linked the Discord message

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
    // Use descriptive placeholder for attachment-only messages (empty content but has attachments)
    const currentAttachments = intent.context?.attachments || [];
    const hasAttachments =
      currentAttachments.length > 0 || intent.context?.recentAttachments?.length > 0;

    let messageContent = intent.content;
    if (!messageContent && hasAttachments) {
      // Build descriptive placeholder: "jonah_ab uploaded game.metro"
      const slugify = (str: string) =>
        str
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 8);
      const senderSlug = slugify(intent.username || 'user');
      const filenames = currentAttachments.map((a: any) => a.name || 'file').join(', ');
      messageContent = `${senderSlug} uploaded ${filenames || 'attachment'}`;
    }

    const jobInfo = await capabilitiesClient.submitJob(
      messageContent,
      intent.userId,
      intent.context
    );

    // DEFENSIVE: Validate jobInfo structure before using it
    if (!jobInfo || !jobInfo.messageId) {
      const errorDetails = {
        hasJobInfo: !!jobInfo,
        jobInfoKeys: jobInfo ? Object.keys(jobInfo) : [],
        jobInfoValue: jobInfo,
      };
      logger.error(`❌ NULL JOB ID DETECTED [${shortId}]:`, errorDetails);
      throw new Error(`Invalid job response: ${JSON.stringify(errorDetails)}`);
    }

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

      // Recovery: resubmit if job is orphaned (e.g., capabilities restarted)
      onOrphaned: async () => {
        const downtimeMs = Date.now() - startTime;
        const downtimeSeconds = (downtimeMs / 1000).toFixed(1);
        logger.info(
          `🔄 Attempting to recover orphaned job [${shortId}] after ${downtimeSeconds}s downtime...`
        );

        try {
          // Inject recovery context so Artie knows he went down
          const recoveryContext = {
            ...intent.context,
            systemNote: `[SYSTEM: You experienced a brief service interruption. You were processing this message for ${downtimeSeconds} seconds before your backend restarted. Acknowledge this briefly and naturally (e.g., "Whoa, sorry about that - I went down for a moment there. Anyway...") then continue helping with their request.]`,
          };

          const newJobInfo = await capabilitiesClient.submitJob(
            messageContent,
            intent.userId,
            recoveryContext
          );
          if (newJobInfo?.messageId) {
            logger.info(
              `✅ Recovered job [${shortId}] → new job ${newJobInfo.messageId.slice(-8)} (after ${downtimeSeconds}s)`
            );
            return newJobInfo.messageId;
          }
          return null;
        } catch (error) {
          logger.error(`❌ Failed to recover job [${shortId}]:`, error);
          return null;
        }
      },

      // Progress updates
      onProgress: async (status) => {
        try {
          // ENHANCED: Smart streaming with better formatting
          if (
            enableStreaming &&
            status.partialResponse &&
            status.partialResponse !== lastSentContent
          ) {
            // Clean capability tags before streaming. Also scrub control markers:
            // strip complete [SILENT]/[TIMEOUT] tokens and hold back a possibly
            // incomplete marker at the tail so "[SILEN"/"[TIMEO" never gets posted
            // mid-stream (that's how literal "[SILENT]" leaked into the channel).
            const cleanedResponse = cleanCapabilityTags(status.partialResponse)
              .replace(/\[(?:SILENT|TIMEOUT(?::\d{1,3})?|GAMBLE(?::\d{1,3}){0,2}|WHEEL(?::[^\]\n]{1,40})?|DEAL(?::\d{1,3})?|HIT|STAND|SLOTS(?::\d{1,3})?)\]/gi, '')
              .replace(/\[[A-Za-z]{0,8}(?::[^\]\n]{0,40})?$/, '');
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

                    // Context Alchemy: Link Discord message to trace for feedback correlation
                    if (!discordMessageLinked && intent.getResponseMessageId) {
                      const discordMsgId = intent.getResponseMessageId();
                      if (discordMsgId && jobInfo?.messageId) {
                        discordMessageLinked = true;
                        capabilitiesClient
                          .linkDiscordMessage(jobInfo.messageId, discordMsgId)
                          .catch((err) => {
                            logger.debug(`Failed to link Discord message [${shortId}]:`, err);
                          });
                      }
                    }
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

                  // Context Alchemy: Link Discord message to trace for feedback correlation
                  if (!discordMessageLinked && intent.getResponseMessageId) {
                    const discordMsgId = intent.getResponseMessageId();
                    if (discordMsgId && jobInfo?.messageId) {
                      discordMessageLinked = true;
                      capabilitiesClient
                        .linkDiscordMessage(jobInfo.messageId, discordMsgId)
                        .catch((err) => {
                          logger.debug(`Failed to link Discord message [${shortId}]:`, err);
                        });
                    }
                  }
                }
              }
            }
          }

          // MINIMAL: No emoji reactions - just pure human-like behavior
          lastStatus = status.status;
          updateCount++;

          // Add capability emoji reactions to user's message
          if (intent.addReaction && status.capabilityEmojis) {
            for (const emoji of status.capabilityEmojis) {
              if (!reactedEmojis.has(emoji)) {
                reactedEmojis.add(emoji);
                await intent.addReaction(emoji);
              }
            }
          }
        } catch (error) {
          logger.warn(`Progress update failed [${shortId}]:`, error);
        }
      },

      // Job completion
      onComplete: async (result) => {
        logger.info(`🎉 ONCOMPLETE CALLBACK FIRED [${shortId}]:`, {
          correlationId,
          jobId: jobInfo.messageId,
          jobIdType: typeof jobInfo.messageId,
          hasResult: !!result,
          resultType: typeof result,
          resultLength: result?.length || 0,
          resultPreview: result?.substring(0, 100),
          alreadyCompleted: jobCompleted,
          streamedChunks,
        });

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
          // Clean the response of capability tags.
          // GUARDRAIL: no "No response received" fallback — empty stays empty so we can stay silent.
          let cleanResult = cleanCapabilityTags(result || '');
          // WARDEN TIMEOUT: if Artie marked [TIMEOUT] / [TIMEOUT:NN], time out the person he is
          // replying to (guardrails enforced in intent.timeoutAuthor), then strip the marker.
          const _toMatch = cleanResult.match(/\[TIMEOUT(?::(\d{1,3}))?\]/i);
          if (_toMatch && typeof (intent as any).timeoutAuthor === 'function') {
            const _secs = Math.min(300, Math.max(5, parseInt(_toMatch[1] || '30', 10) || 30));
            void (intent as any).timeoutAuthor(_secs, 'Coach Artie warden discipline');
            cleanResult = cleanResult.replace(/\[TIMEOUT(?::\d{1,3})?\]/gi, '').trim();
          }
          // [SILENT] handling: a leading marker means "stay silent" even if chatter
          // follows it; a stray embedded marker gets stripped so it never reaches
          // the channel (with a proxy prefix it was posting verbatim).
          if (/^\s*\[SILENT\]/i.test(cleanResult)) {
            cleanResult = '';
          } else {
            cleanResult = cleanResult.replace(/\[SILENT\]/gi, '').trim();
          }
          // TIMEOUT ROULETTE — SELF-SPIN: [GAMBLE] / [GAMBLE:NN] / [GAMBLE:NN:P]. The gambler
          // is the person Artie is replying to; playing is consent. The dice roll HERE,
          // server-side, after the LLM has finished talking — it cannot rig, predict, or fake
          // the outcome. P = survival odds percent (10-90); surviving pays yard cred at fair
          // odds (stake × (100−P)/P) into the persistent house ledger. On a loss the timeout
          // is real (same gate/cooldown as warden discipline). If the box mechanism jams
          // (cooldown, protected user), the verdict says so instead of lying about a served
          // sentence — and the ledger doesn't record time that wasn't served.
          const _gMatch = cleanResult.match(/\[GAMBLE(?::(\d{1,3})(?::(\d{1,2}))?)?\]/i);
          if (_gMatch && typeof (intent as any).timeoutAuthor === 'function') {
            bumpHouseEvents();
            const _stake = Math.min(300, Math.max(5, parseInt(_gMatch[1] || '60', 10) || 60));
            const _odds = Math.min(90, Math.max(10, parseInt(_gMatch[2] || '50', 10) || 50));
            cleanResult = cleanResult.replace(/\[GAMBLE(?::\d{1,3}){0,2}\]/gi, '').trim();
            const _roll = Math.floor(Math.random() * 100) + 1; // 1-100, shown for legibility
            const _won = _roll <= _odds;
            const _payout = Math.max(1, Math.round((_stake * (100 - _odds)) / _odds));
            let _verdict: string;
            if (_won) {
              const _e = recordSelfSpin(intent.userId, intent.username || 'gambler', true, _payout, 0);
              const _safe = [
                `The box goes hungry tonight.`,
                `Walk away. Never come back. (Come back.)`,
                `The house glares, but pays.`,
              ];
              _verdict =
                `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟩 **SAFE.** ` +
                `${_safe[Math.floor(Math.random() * _safe.length)]} ` +
                `Payout **+${_payout} cred** → ${_e.cred} cred (${_e.streak > 1 ? `W${_e.streak} streak` : 'fresh win'}).`;
            } else {
              const _landed = await (intent as any).timeoutAuthor(
                _stake,
                `Timeout roulette — rolled ${_roll} vs ${_odds}, staked ${_stake}s`
              );
              if (_landed) {
                const _e = recordSelfSpin(intent.userId, intent.username || 'gambler', false, 0, _stake);
                const _loss = [
                  `The house thanks you for your patronage.`,
                  `${_stake} seconds of contemplative silence, effective immediately.`,
                  `No refunds. The wheel loves you.`,
                ];
                _verdict =
                  `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟥 **THE BOX. ${_stake}s.** ` +
                  `${_loss[Math.floor(Math.random() * _loss.length)]} ` +
                  `(${_e.cred} cred, ${_e.served}s lifetime served${_e.streak < -1 ? `, L${-_e.streak} skid` : ''})`;
              } else {
                _verdict = `🎰 **THE WHEEL** — roll ${_roll}/100, survive ≤${_odds}: 🟥 THE BOX — but the mechanism jammed. Sentence commuted. The house is FURIOUS.`;
              }
            }
            _verdict = withMelt(_verdict);
            cleanResult = cleanResult ? `${cleanResult}\n\n${_verdict}` : _verdict;
          }
          // BLACKJACK & SLOTS — real server-side games. The LLM's patter is flavor; the
          // appended TABLE/REELS block is the actual cards/reels, dealt here where the
          // model can't fudge them. Stakes are real: busts and flushes hit the same
          // timeoutAuthor path as roulette; wins pay yard cred into the ledger.
          const _tableChannel = String((intent.context as any)?.channelId || 'dm');
          const _gambler = intent.username || 'gambler';
          const _dealM = cleanResult.match(/\[DEAL(?::(\d{1,3}))?\]/i);
          const _hitM = cleanResult.match(/\[HIT\]/i);
          const _standM = cleanResult.match(/\[STAND\]/i);
          const _slotsM = cleanResult.match(/\[SLOTS(?::(\d{1,3}))?\]/i);
          if (_dealM || _hitM || _standM || _slotsM) {
            bumpHouseEvents();
            cleanResult = cleanResult
              .replace(/\[(?:DEAL(?::\d{1,3})?|HIT|STAND|SLOTS(?::\d{1,3})?)\]/gi, '')
              .trim();
            let _house = '';
            if (_dealM) {
              const _stake = Math.min(300, Math.max(5, parseInt(_dealM[1] || '60', 10) || 60));
              const d = bjDeal(_tableChannel, intent.userId, _gambler, _stake);
              if (d.natural) {
                const _pay = Math.round(_stake * 1.5);
                if (d.dealerNatural) {
                  _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} (21) · dealer: ${bjFmt(d.session.dealer)} (21). **DOUBLE BLACKJACK — PUSH.** Nobody bleeds, nobody eats.`;
                } else {
                  const _e = adjustCred(intent.userId, _gambler, _pay);
                  _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} — **BLACKJACK OFF THE DEAL.** Dealer: ${bjFmt(d.session.dealer)} (${d.dealerValue}). Payout **+${_pay} cred** → ${_e.cred}.`;
                }
              } else {
                _house = `🃏 **THE TABLE** (${_stake}s stake) — you: ${bjFmt(d.session.player)} (${d.playerValue}) · dealer shows ${bjFmt([d.session.dealer[0]])} + 🂠. Hit or stand.`;
              }
            } else if (_hitM) {
              const h = bjHit(_tableChannel, intent.userId);
              if (!h) {
                _house = `🃏 **THE TABLE** — no live hand for ${_gambler}. Cards don't deal themselves, sport — ask for a deal.`;
              } else if (h.bust) {
                const _landed = await (intent as any).timeoutAuthor?.(
                  h.session.stake,
                  `Blackjack bust — ${h.playerValue}, staked ${h.session.stake}s`
                );
                const _e = _landed
                  ? recordTableServed(intent.userId, _gambler, h.session.stake)
                  : null;
                _house = `🃏 **THE TABLE** — you draw ${bjFmt([h.drawn])} → ${bjFmt(h.session.player)} (${h.playerValue}). 🟥 **BUST — THE BOX. ${h.session.stake}s.**${_e ? ` (${_e.served}s lifetime served)` : ' The mechanism jammed — sentence commuted, the house seethes.'}`;
              } else {
                _house = `🃏 **THE TABLE** — you draw ${bjFmt([h.drawn])} → ${bjFmt(h.session.player)} (${h.playerValue}). Dealer shows ${bjFmt([h.session.dealer[0]])} + 🂠. Hit or stand.`;
              }
            } else if (_standM) {
              const s = bjStand(_tableChannel, intent.userId);
              if (!s) {
                _house = `🃏 **THE TABLE** — no live hand for ${_gambler}. Standing on nothing is very zen, but ask for a deal first.`;
              } else if (s.outcome === 'win') {
                const _e = adjustCred(intent.userId, _gambler, s.session.stake);
                _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}${s.dealerValue > 21 ? ' — BUST' : ''}). You: ${s.playerValue}. 🟩 **WIN +${s.session.stake} cred** → ${_e.cred}.`;
              } else if (s.outcome === 'push') {
                _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}). You: ${s.playerValue}. **PUSH.** The felt keeps its secrets.`;
              } else {
                const _landed = await (intent as any).timeoutAuthor?.(
                  s.session.stake,
                  `Blackjack loss — ${s.playerValue} vs dealer ${s.dealerValue}, staked ${s.session.stake}s`
                );
                const _e = _landed
                  ? recordTableServed(intent.userId, _gambler, s.session.stake)
                  : null;
                _house = `🃏 **THE TABLE** — dealer: ${bjFmt(s.session.dealer)} (${s.dealerValue}). You: ${s.playerValue}. 🟥 **HOUSE WINS — THE BOX. ${s.session.stake}s.**${_e ? ` (${_e.served}s lifetime served)` : ' The mechanism jammed — sentence commuted, the house seethes.'}`;
              }
            } else if (_slotsM) {
              const _stake = Math.min(120, Math.max(5, parseInt(_slotsM[1] || '30', 10) || 30));
              const r = spinSlots(_stake);
              const _row = r.reels.join(' ');
              if (r.credDelta > 0) {
                const _e = adjustCred(intent.userId, _gambler, r.credDelta);
                _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — **${r.label.toUpperCase()}! +${r.credDelta} cred** → ${_e.cred}.`;
              } else if (r.boxSeconds > 0) {
                const _landed = await (intent as any).timeoutAuthor?.(
                  r.boxSeconds,
                  `Slots — ${r.label}, ${r.boxSeconds}s`
                );
                if (_landed) recordTableServed(intent.userId, _gambler, r.boxSeconds);
                _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — 🟥 **${r.label.toUpperCase()}. THE BOX: ${r.boxSeconds}s.**${_landed ? '' : ' The mechanism jammed — the toilet gods show mercy.'}`;
              } else {
                _house = `🎰 **THE REELS** (${_stake}s a pull) — ${_row} — nothing. The house keeps your quarter.`;
              }
            }
            if (_house) {
              _house = withMelt(_house);
              cleanResult = cleanResult ? `${cleanResult}\n\n${_house}` : _house;
            }
          }
          // WHEEL OF FATE — THIRD-PARTY SPIN: [WHEEL] / [WHEEL:NN] / [WHEEL:NN:name]. The
          // victim pool is humans recently active in the channel (vetted through the same
          // protection list as warden timeouts); target picking, the roll, and the real
          // timeout all happen in the discord handler — server-side, unriggable.
          const _wMatch = cleanResult.match(/\[WHEEL(?::(\d{1,3}))?(?::([^\]\n]{1,32}))?\]/i);
          if (_wMatch && typeof (intent as any).spinChannelWheel === 'function') {
            bumpHouseEvents();
            cleanResult = cleanResult.replace(/\[WHEEL(?::[^\]\n]{1,40})?\]/gi, '').trim();
            const _spin = await (intent as any).spinChannelWheel(
              parseInt(_wMatch[1] || '60', 10) || 60,
              _wMatch[2]?.trim() || undefined
            );
            let _verdict: string;
            if (!_spin.target) {
              _verdict = `🎡 **WHEEL OF FATE** — the wheel spun, wobbled, and found no one it could legally eat. The house files a formal complaint.`;
            } else if (!_spin.boxed) {
              _verdict = `🎡 **WHEEL OF FATE** — the wheel scans the room... locks onto **${_spin.target}**... roll ${_spin.roll}/100 (box on 51+): 🟩 **SPARED.** The wheel is merciful. Today.`;
            } else if (_spin.landed) {
              _verdict = `🎡 **WHEEL OF FATE** — the wheel scans the room... locks onto **${_spin.target}**... roll ${_spin.roll}/100 (box on 51+): 🟥 **THE BOX. ${_spin.stake}s.** Fate sends its regards.`;
            } else {
              _verdict = `🎡 **WHEEL OF FATE** — the wheel locks onto **${_spin.target}**... roll ${_spin.roll}/100: 🟥 THE BOX — but the mechanism jammed. **${_spin.target}** walks. The house is FURIOUS.`;
            }
            _verdict = withMelt(_verdict);
            cleanResult = cleanResult ? `${cleanResult}\n\n${_verdict}` : _verdict;
          }
          // Banned users may be referenced but never named or @-pinged. The prompt
          // rule handles this most of the time; this is the insurance for when a
          // budget model slips.
          cleanResult = scrubBlockedUserMentions(cleanResult);

          logger.info(`📝 FINAL RESPONSE DELIVERY [${shortId}]:`, {
            cleanResultLength: cleanResult.length,
            cleanResultPreview: cleanResult.substring(0, 100),
            enableEditing,
            hasStreamingMessage: !!streamingMessage,
            lastSentContentLength: lastSentContent.length,
            streamedChunks,
          });

          // GUARDRAIL: never deliver an empty/failed generation, and never deliver a slur/hate
          // term (even in roast mode). Either case → stay silent instead of posting.
          const containsSlur = OUTPUT_SLUR_BLOCKLIST.test(cleanResult);
          const leaksInternals = INTERNAL_LEAK_BLOCKLIST.test(cleanResult);
          if (!cleanResult.trim() || containsSlur || leaksInternals) {
            logger.warn(
              containsSlur
                ? `🛑 Output blocked by slur blacklist [${shortId}] — staying silent`
                : `🛑 Empty/failed generation [${shortId}] — staying silent (no fallback message sent)`
            );
            // If a partial message already streamed out, pull it back — otherwise the
            // suppressed content stays half-posted in the channel.
            if (streamedChunks > 0 && typeof (intent as any).deleteResponse === 'function') {
              try {
                await (intent as any).deleteResponse();
              } catch {
                // best effort — the partial staying up is not worth crashing delivery
              }
            }
          }
          // ENHANCED: Handle final response with edit-based streaming
          else if (enableEditing && streamingMessage && lastSentContent) {
            // For edit-based streaming, ensure final content is properly set
            const trimmedResult = cleanResult.trim();
            const trimmedSent = lastSentContent.trim();

            logger.info(`📝 EDIT-BASED DELIVERY [${shortId}]:`, {
              trimmedResultLength: trimmedResult.length,
              trimmedSentLength: trimmedSent.length,
              needsEdit: trimmedResult !== trimmedSent && trimmedResult.length > trimmedSent.length,
            });

            if (trimmedResult !== trimmedSent && trimmedResult.length > trimmedSent.length) {
              try {
                if (intent.editResponse) {
                  logger.info(
                    `📝 Calling editResponse with ${cleanResult.length} chars [${shortId}]`
                  );
                  await intent.editResponse(cleanResult);
                  logger.info(`✅ Final edit completed [${shortId}]: ${cleanResult.length} chars`);
                }
              } catch (error) {
                logger.error(`❌ Failed final edit [${shortId}]:`, error);
              }
            } else {
              logger.info(`No final edit needed [${shortId}] (content complete)`);
            }
          } else if (streamedChunks === 0) {
            // No streaming happened, send complete response
            logger.info(`📝 Sending complete response [${shortId}]: ${cleanResult.length} chars`);
            await intent.respond(cleanResult);
            logger.info(`✅ Sent final response [${shortId}] (no streaming)`);
          } else {
            // Traditional streaming - check for additional content
            const trimmedResult = cleanResult.trim();
            const trimmedSent = lastSentContent.trim();

            logger.info(`📝 STREAMING DELIVERY [${shortId}]:`, {
              trimmedResultLength: trimmedResult.length,
              trimmedSentLength: trimmedSent.length,
              difference: trimmedResult.length - trimmedSent.length,
            });

            if (trimmedResult.length > trimmedSent.length + 20) {
              const additionalContent = trimmedResult.slice(trimmedSent.length).trim();
              if (additionalContent && !additionalContent.startsWith(trimmedSent.slice(-10))) {
                logger.info(
                  `📝 Sending additional content [${shortId}]: ${additionalContent.length} chars`
                );
                await intent.respond(additionalContent);
                logger.info(
                  `✅ Sent additional final content [${shortId}]: ${additionalContent.slice(0, 50)}...`
                );
              } else {
                logger.info(`Skipped final response [${shortId}] (redundant with stream)`);
              }
            } else {
              logger.info(`Skipped final response [${shortId}] (already fully streamed)`);
            }
          }

          // Check for and send any pending file attachments (e.g., analyzed .metro files)
          if (intent.sendFile) {
            try {
              const pendingAttachments = await capabilitiesClient.getPendingAttachments(
                intent.userId
              );
              if (pendingAttachments.length > 0) {
                logger.info(
                  `📎 Sending ${pendingAttachments.length} pending attachments [${shortId}]`
                );
                for (const att of pendingAttachments) {
                  const buffer = Buffer.from(att.data, 'base64');
                  await intent.sendFile({
                    buffer,
                    filename: att.filename,
                    content: att.content,
                  });
                }
                logger.info(`✅ Sent all pending attachments [${shortId}]`);
              }
            } catch (attError) {
              logger.warn(`Failed to send pending attachments [${shortId}]:`, attError);
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

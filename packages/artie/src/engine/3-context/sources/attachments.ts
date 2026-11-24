/**
 * Attachment / reply / user-state context source builders extracted verbatim from
 * ContextAlchemy. These depend only on their arguments plus module-level helpers
 * (vision wrapper, metro doctor, memory service, analysis reader) — no instance
 * state — so they live here as plain functions. Behavior matched the original private
 * methods at extraction; deliberate changes since are dated in place (2026-10-28:
 * attachment scoping in addAttachmentContext).
 */

import { logger } from '../../../shared/logger.js';
import { estimateTokens } from '../../../shared/async.js';
import type { IncomingMessage } from '../../../shared/queue/types.js';
import { visionCapability as visionCap } from '../../tools/media/vision.js';
import { processMetroAttachment } from '../../metro/analyze.js';
import { MemoryService } from '../../tools/core/memory.js';
import { storeAnalyzedMetroFile, readAnalysis } from '../../1-intake/pending-attachments.js';
import { getUserScores, formatUserScores } from '../../2-turn/user-scores.js';
import type { ContextSource } from './types.js';
import { DEBUG } from './types.js';
import { toCallNotation } from '../../5-tool-loop/mode.js';
import { collapseWhitespace } from '../../../shared/text.js';
import { isAudioAttachment, transcribeVoiceMemos, formatMemoContext } from '../../jobs/scribe/voice-memo.js';

/** How to send the analyzed save back, in call notation. */
function sendMetroFileHint(): string {
  const xml =
    'TO SEND FILE: <capability name="send-metro-file" action="send" userId="USER_ID" message="Your message here" />';
  return toCallNotation(xml);
}

// Vision capability wrapper for auto-extraction
const visionCapability: { execute: (opts: any) => Promise<string> } | null = {
  execute: async (opts: { action: string; urls: string[]; objective?: string }) => {
    return visionCap.handler(
      { action: opts.action, urls: opts.urls, objective: opts.objective },
      ''
    );
  },
};

/**
 * Inject the ongoing per-user vibe profile so Artie's tone can adapt to who he's
 * talking to. Only added once the user has enough history to be meaningful.
 */
export async function addUserScores(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    const userId = message.userId;
    if (!userId) return;
    const guildId = (message.context as { guildId?: string } | undefined)?.guildId || '';
    const scores = getUserScores(userId, guildId);
    if (!scores || scores.interactions < 2) return; // wait for a little signal first

    sources.push({
      name: 'user_vibe_profile',
      priority: 55, // background flavor — informs tone, not a headline
      tokenWeight: 40,
      content: `👤 What you've learned about this person over ${scores.interactions} chats: ${formatUserScores(
        scores
      )}. Let it subtly inform your tone — don't recite these numbers back robotically.`,
      category: 'user_state',
    });
  } catch (error) {
    logger.warn('Failed to add user vibe scores:', error);
  }
}

export async function addReplyContext(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  const ctx = message.context;
  if (!ctx || !ctx.replyContext) {
    return;
  }

  const reply = ctx.replyContext;
  // The person in <user_message> is pointing AT this earlier message — it's context they're
  // referencing, NOT the person to answer. Framing it as "Replying to @X" made Artie answer
  // @X (the previous speaker) instead of whoever actually just messaged him.
  const content = `💬 The person messaging you (see <user_message>) is referencing an earlier message from @${reply.author}: "${reply.content}". Treat that quoted message as CONTEXT only — respond to the person who just messaged you, not to @${reply.author}.`;

  sources.push({
    name: 'reply_context',
    priority: 97, // Very high priority - directly relevant to understanding the conversation
    tokenWeight: estimateTokens(content),
    content,
    category: 'user_state',
  });

  if (DEBUG) {
    logger.info(
      `│ ✅ Added reply context: @${reply.author} - "${reply.content.substring(0, 50)}..."`
    );
  }
}

/** Silence longer than this ends a conversation; an image from before it isn't "recent". */
const CONVERSATION_GAP_MS = 45 * 60_000;
/** Hard ceiling on how old an un-replied-to earlier image can be. */
const EARLIER_MAX_AGE_MS = 60 * 60_000;

/**
 * Split attachments into the ones this message is about (its own, plus those on the
 * message it replies to) and earlier ones from the same conversation. Earlier images
 * are dropped once they're over an hour old or sit behind a 45-minute lull: a quiet
 * channel's old screenshot belongs to a different conversation.
 */
export function splitAttachments(
  current: any[],
  recent: any[],
  replyingTo?: string | null,
  now: number = Date.now()
): { addressed: any[]; earlier: any[] } {
  const hasUrl = (att: any) => !!att?.url;
  const repliedTo = recent.filter((att) => !!replyingTo && att?.messageId === replyingTo);

  const others = recent
    .filter((att) => !repliedTo.includes(att))
    .filter(hasUrl)
    .map((att) => ({ att, t: new Date(att?.timestamp ?? NaN).getTime() }))
    .sort((a, b) => b.t - a.t); // newest first; undated sorts last and is dropped below
  const earlier: any[] = [];
  let edge = now;
  for (const { att, t } of others) {
    if (!Number.isFinite(t) || now - t > EARLIER_MAX_AGE_MS || edge - t > CONVERSATION_GAP_MS) {
      break;
    }
    earlier.push(att);
    edge = t;
  }

  return { addressed: [...current, ...repliedTo].filter(hasUrl), earlier };
}

function ageLabel(timestamp?: string): string {
  if (!timestamp) return '';
  const mins = Math.round((Date.now() - new Date(timestamp).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 60) return `, ${mins}m ago`;
  return `, ${Math.round(mins / 60)}h ago`;
}

/**
 * Attachment context (URLs and metadata). Encourages vision/OCR or user-provided text.
 */
export async function addAttachmentContext(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  const messageText = message.message || '';
  let currentAttachments: any[] = [];
  if (Array.isArray(message.context?.attachments)) {
    currentAttachments = message.context.attachments;
  }

  let recentAttachments: any[] = [];
  if (Array.isArray(message.context?.recentAttachments)) {
    recentAttachments = message.context.recentAttachments;
  }

  let recentUrls: any[] = [];
  if (Array.isArray(message.context?.recentUrls)) {
    recentUrls = message.context.recentUrls;
  }
  const recentMetroAttachments = recentAttachments.filter(
    (att: any) =>
      typeof att?.name === 'string' &&
      att.name.toLowerCase().endsWith('.metro') &&
      (!att.authorId || att.authorId === message.userId)
  );

  let contextKeys: string[] = [];
  if (message.context) {
    contextKeys = Object.keys(message.context);
  }

  logger.info(
    `📎 ATTACHMENT DEBUG: current=${currentAttachments.length}, recent=${recentAttachments.length}, urls=${recentUrls.length}`,
    {
      contextKeys,
      hasAttachmentsField: !!message.context?.attachments,
      hasRecentAttachmentsField: !!message.context?.recentAttachments,
      debugCurrent: message.context?._debug_currentAttachmentCount,
      debugRecent: message.context?._debug_recentAttachmentCount,
    }
  );

  const attachments = [...currentAttachments, ...recentAttachments].filter((att) => !!att?.url);
  logger.info(`📎 ATTACHMENT DEBUG: combined after filter=${attachments.length}`);

  // Only what the speaker attached, or attached to the message they're replying to, is
  // "their" image. Anything else is someone else's earlier post: listed, never auto-analyzed.
  // (2026-10-28: auto-vision on another member's UK photos, framed as the speaker's,
  // made Artie insist an applesauce joke came with "Sharpness Dock" screenshots.)
  const { addressed, earlier } = splitAttachments(
    currentAttachments,
    recentAttachments,
    message.context?.replyingTo
  );

  const shown = addressed.length + earlier.length;
  if (shown > 0) {
    const lines: string[] = [];
    lines.push(`📎 Attachments detected (${shown})`);

    const seen = new Set<string>();
    const listAttachment = (att: any, idx: number) => {
      const url = att.url || att.proxyUrl;
      if (!url || seen.has(url)) return;
      seen.add(url);

      const label = att.name || att.id || `attachment-${idx + 1}`;
      let type = '';
      if (att.contentType) {
        type = ` (${att.contentType})`;
      }
      let from = '';
      if (att.author) {
        from = ` by ${att.author}`;
      }
      lines.push(`- ${label}${type}${from}${ageLabel(att.timestamp)}: ${url}`);
    };
    addressed.slice(0, 8).forEach(listAttachment);
    if (earlier.length > 0 && addressed.length < 8) {
      lines.push(
        'Posted earlier in the channel, NOT attached to this message (only look at these if the person asks about them):'
      );
      earlier.slice(0, 8 - addressed.length).forEach(listAttachment);
    }

    if (shown > 8) {
      lines.push(`…and ${shown - 8} more (see context)`);
    }

    // Check for .metro files in attachments
    const metroFiles = attachments.filter(
      (att: any) => typeof att.name === 'string' && att.name.toLowerCase().endsWith('.metro')
    );
    if (metroFiles.length > 0) {
      lines.push(
        '\n🎮 Metro save files detected! You have already analyzed these or can use the metro-doctor to analyze them.'
      );
      lines.push('If the user asks about "my save" or "the file", they mean these metro files.');
      if (recentMetroAttachments.length > 0) {
        const mostRecent = recentMetroAttachments[0];
        const recentLabel = mostRecent.name || mostRecent.id || 'save.metro';
        lines.push(`Recent save from this user is available: ${recentLabel}`);
      }
    } else if (addressed.some((att: any) => !isAudioAttachment(att))) {
      lines.push(
        'Vision/OCR recommended: call the vision capability with these URLs to extract text/entities, or ask the user to paste the text if vision is unavailable.'
      );
    }

    const content = lines.join('\n');

    sources.push({
      name: 'attachments',
      priority: 95, // High, near reply context
      tokenWeight: estimateTokens(content),
      content,
      category: 'user_state',
    });
  }

  // Voice memos (2026-11-23): audio the person attached is transcribed, never sent to vision.
  // The speaker's own memos carry their id; replied-to ones keep the poster's authorId and are
  // marked, so they're framed as someone else's words and opt-outs are honored.
  const heardAudio = addressed
    .filter((att: any) => isAudioAttachment(att))
    .map((att: any) => {
      if (currentAttachments.includes(att)) {
        return { ...att, authorId: message.userId, fromReply: false };
      }
      return { ...att, fromReply: true };
    });
  const visual = addressed.filter((att: any) => !isAudioAttachment(att));
  if (heardAudio.length > 0 && process.env.OPENROUTER_API_KEY) {
    const memos = await transcribeVoiceMemos(heardAudio, {
      userId: message.userId,
      guildId: message.context?.guildId,
      messageId: message.context?.messageId,
    });
    if (memos.length > 0) {
      const content = formatMemoContext(memos);
      sources.push({
        name: 'attachments_audio',
        priority: 96, // it IS the message, often the whole of it
        tokenWeight: estimateTokens(content),
        content,
        category: 'user_state',
      });
    }
  }

  // Optional: auto vision extraction
  const autoVision =
    (process.env.AUTO_VISION_EXTRACT || 'true').toLowerCase() !== 'false' &&
    !!process.env.OPENROUTER_API_KEY &&
    visionCapability !== null;

  if (autoVision && visual.length > 0) {
    const urls = visual
      .map((att: any) => att.url || att.proxyUrl)
      .filter((u: any) => typeof u === 'string')
      .slice(0, 3); // cap auto-processing

    if (urls.length > 0) {
      try {
        // Build context-aware vision objective based on guild
        const guildId = message.context?.guildId;
        const guildName = message.context?.guildName;

        let visionObjective =
          'Describe what you see in these images. Include any text, objects, people, scenes, UI elements, or other notable content. Be specific and detailed.';

        // Subway Builder guild - images are usually game screenshots
        if (guildId === '1420846272545296470' || guildName?.toLowerCase().includes('subway')) {
          visionObjective = `These may be screenshots from "Subway Builder", a hyperrealistic transit simulation game, or ordinary photos and memes. Say which they look like.
IMPORTANT: Read ALL text and numbers EXACTLY as shown - do not approximate or guess. Pay special attention to:
- Statistics panels (ridership numbers, percentages, costs)
- Map elements (station names, line colors, route layouts)
- UI elements (menus, tooltips, status indicators)
- Any error messages or notifications
Be precise with numbers - if it says 1.5%, report 1.5% not 1.1%. If you can't read something clearly, say so rather than guessing.`;
        }

        const visionResult = await visionCapability!.execute({
          action: 'extract',
          urls,
          objective: visionObjective,
        } as any);

        // Trim if very long to avoid context bloat
        const MAX_VISION_CHARS = 2000;
        let truncated: string;
        if (visionResult.length > MAX_VISION_CHARS) {
          truncated = visionResult.slice(0, MAX_VISION_CHARS) + '\n…[truncated]';
        } else {
          truncated = visionResult;
        }

        // Frame the vision output clearly so the LLM knows the images were already analyzed
        const posters = [...new Set(visual.map((att: any) => att.author).filter(Boolean))];
        let postedBy = '';
        if (posters.length > 0) {
          postedBy = ` (posted by ${posters.join(', ')})`;
        }
        const framedContent = `🖼️ IMAGE ANALYSIS COMPLETE - The following images${postedBy} were analyzed using vision AI:\n\n${truncated}\n\n(Use this analysis to answer questions about the images - do NOT say you cannot view images.)`;

        sources.push({
          name: 'attachments_vision',
          priority: 90, // slightly below attachment listing, above memories
          tokenWeight: estimateTokens(framedContent),
          content: framedContent,
          category: 'evidence',
        });
      } catch (error: any) {
        const msg = `Vision auto-extract failed: ${error?.message || String(error)}`;
        sources.push({
          name: 'attachments_vision_error',
          priority: 60,
          tokenWeight: estimateTokens(msg),
          content: msg,
          category: 'system',
        });
        logger.warn(msg);
      }
    }
  }

  // Optional: auto metro doctor for .metro files
  // IMPORTANT: Only process metro files from the CURRENT message, not recentAttachments
  // Otherwise we'd re-send metro files every time someone mentions Artie in a channel
  function isMetroFile(att: any): boolean {
    if (typeof att.name === 'string') {
      return att.name.toLowerCase().endsWith('.metro');
    }
    return false;
  }

  const metroAttachments = currentAttachments.filter((att: any) => isMetroFile(att));
  const autoMetro = (process.env.AUTO_METRO_DOCTOR || 'true').toLowerCase() !== 'false';

  // Check if user explicitly mentions .metro files
  // Don't use keyword heuristics to guess transit intent - let the LLM handle context
  const isMetroFollowup = messageText.toLowerCase().includes('.metro');

  const pickMostRecent = (items: any[]) => {
    return items.slice().sort((a, b) => {
      let aTime = 0;
      if (a.timestamp) {
        aTime = new Date(a.timestamp).getTime();
      }
      let bTime = 0;
      if (b.timestamp) {
        bTime = new Date(b.timestamp).getTime();
      }
      return bTime - aTime;
    })[0];
  };

  let metroCandidate = metroAttachments[0];
  let metroSource: 'current' | 'recent' = 'current';

  if (!metroCandidate && isMetroFollowup && recentMetroAttachments.length > 0) {
    const recentPick = pickMostRecent(recentMetroAttachments);
    if (recentPick?.timestamp) {
      const ageMs = Date.now() - new Date(recentPick.timestamp).getTime();
      const maxAgeMs = 1000 * 60 * 60 * 2; // 2 hours
      if (ageMs <= maxAgeMs) {
        metroCandidate = recentPick;
        metroSource = 'recent';
        logger.info(
          `🧵 Using recent metro attachment for follow-up (age ${(ageMs / 60000).toFixed(1)}m)`
        );
      }
    }
  }

  // For metro follow-ups, try to recall from memory FIRST before re-downloading
  if (autoMetro && metroSource === 'recent' && isMetroFollowup) {
    try {
      const memoryService = MemoryService.getInstance();
      const metroMemories = await memoryService.recallByTags(
        message.userId,
        ['metro', 'save', 'analysis'],
        3
      );

      // Filter to recent memories (< 2 hours)
      const recentMetroMemory = metroMemories.find((mem) => {
        const ageMs = Date.now() - new Date(mem.timestamp).getTime();
        return ageMs < 1000 * 60 * 60 * 2; // 2 hours
      });

      if (recentMetroMemory) {
        logger.info(
          `🧠 Found recent metro analysis in memory - using that instead of re-downloading`
        );
        const memoryContent = `PREVIOUS METRO ANALYSIS (from memory):
${recentMetroMemory.content}`;

        sources.push({
          name: 'metro_memory',
          priority: 99, // Highest priority
          tokenWeight: estimateTokens(memoryContent),
          content: memoryContent,
          category: 'evidence',
        });

        // Skip re-downloading since we have the analysis in memory
        metroCandidate = null;
      }
    } catch (memError) {
      logger.warn(`Failed to recall metro memory: ${memError}`);
      // Continue with normal processing
    }
  }

  // Catch .metro files that arrive as a URL (not a captured attachment) so the savedoctor
  // actually runs on them (size-capped) instead of the raw file path.
  if (autoMetro && !metroCandidate) {
    const metroUrl = recentUrls.find(
      (u: any) => typeof u === 'string' && u.toLowerCase().split('?')[0].endsWith('.metro')
    );
    if (metroUrl) {
      metroCandidate = { url: metroUrl, name: (metroUrl.split('/').pop() || 'save.metro').split('?')[0] };
      metroSource = 'current';
    }
  }

  if (autoMetro && metroCandidate) {
    const first = metroCandidate;
    const url = first.url || first.proxyUrl;
    if (url) {
      try {
        // Pass sender name for filename prefixing
        const sender = message.context?.displayName || message.context?.username;
        const result = await processMetroAttachment(url, sender);

        const MAX_METRO_CHARS = 2000;
        let trimmed: string;
        if (result.stdout.length > MAX_METRO_CHARS) {
          trimmed = result.stdout.slice(0, MAX_METRO_CHARS) + '\n…[truncated]';
        } else {
          trimmed = result.stdout;
        }

        let stderrLine = '';
        if (result.stderr) {
          stderrLine = `Stderr: ${result.stderr.slice(0, 500)}`;
        }

        const _content = [
          '🩺 Metro savefile doctor (auto)',
          `File: ${first.name || first.id || url}`,
          trimmed,
          stderrLine,
        ]
          .filter(Boolean)
          .join('\n');

        // Check if actual repairs were made (filename starts with "repaired_")
        const repairsMade = result.filename.startsWith('repaired_');
        const summary = result.analysis?.summary || '';

        // Store the analyzed file so LLM can decide whether to send it back
        const canSendFile = metroSource === 'current';
        if (canSendFile) {
          let storedFilename: string;
          if (repairsMade) {
            storedFilename = result.filename;
          } else {
            storedFilename = `analyzed_${first.name || 'save.metro'}`;
          }
          storeAnalyzedMetroFile(message.userId, storedFilename, result.buffer, summary);
          logger.info(
            `📦 Stored metro file for LLM to send: ${storedFilename} (repaired: ${repairsMade})`
          );
        }

        if (repairsMade) {
          let metroHint = '';
          if (canSendFile) {
            metroHint = sendMetroFileHint();
          }

          const repairedContent = `METRO SAVE ANALYZED: ${first.name}
Status: Repairs made
${metroHint}

${summary}`;

          sources.push({
            name: 'metro_doctor',
            priority: 99, // Highest priority - this is THE answer
            tokenWeight: estimateTokens(repairedContent),
            content: repairedContent,
            category: 'evidence',
          });

          // Store metro analysis in memory for follow-up questions (with dedup check)
          try {
            const memoryService = MemoryService.getInstance();
            const memoryTags = ['metro', 'save', 'analysis', first.name || 'save.metro'];

            // Check for recent duplicate (< 2 hours) before storing
            const existingMemories = await memoryService.recallByTags(
              message.userId,
              memoryTags,
              1
            );
            const hasDuplicate = existingMemories.some((mem) => {
              const ageMs = Date.now() - new Date(mem.timestamp).getTime();
              return ageMs < 1000 * 60 * 60 * 2; // 2 hours
            });

            if (hasDuplicate) {
              logger.info(
                `📝 Skipping metro memory storage - recent duplicate exists for ${first.name}`
              );
            } else {
              let sendStatus = 'follow-up question';
              if (canSendFile) {
                sendStatus = 'file available to send back';
              }

              const memoryContent = `Metro save file analyzed: ${first.name}
Stats: ${result.analysis?.stats?.stations || 0} stations, ${result.analysis?.stats?.routes || 0} routes, ${result.analysis?.stats?.trains || 0} trains
Money: $${result.analysis?.stats?.money || 0}
Warnings: ${result.analysis?.warnings?.join('; ') || 'None'}
Repairs made: Yes - ${sendStatus}
File URL: ${url}`;
              await memoryService.remember(
                message.userId,
                memoryContent,
                'metro_analysis',
                7, // Importance
                undefined,
                memoryTags
              );
              logger.info(`📝 Stored metro analysis in memory for user ${message.userId}`);
            }
          } catch (memErr) {
            logger.warn(`Failed to store metro analysis in memory: ${memErr}`);
          }
        } else {
          // No repairs needed - just tell the user
          logger.info(`✅ Metro file healthy, no repairs needed: ${first.name}`);

          let metroHint = '';
          if (canSendFile) {
            metroHint = sendMetroFileHint();
          }

          const healthyContent = `METRO SAVE ANALYZED: ${first.name}
Status: Healthy
${metroHint}

${summary}`;

          sources.push({
            name: 'metro_doctor',
            priority: 99, // Highest priority - this is THE answer
            tokenWeight: estimateTokens(healthyContent),
            content: healthyContent,
            category: 'evidence',
          });

          // Store metro analysis in memory for follow-up questions (with dedup check)
          try {
            const memoryService = MemoryService.getInstance();
            const memoryTags = ['metro', 'save', 'analysis', first.name || 'save.metro'];

            // Check for recent duplicate (< 2 hours) before storing
            const existingMemories = await memoryService.recallByTags(
              message.userId,
              memoryTags,
              1
            );
            const hasDuplicate = existingMemories.some((mem) => {
              const ageMs = Date.now() - new Date(mem.timestamp).getTime();
              return ageMs < 1000 * 60 * 60 * 2; // 2 hours
            });

            if (hasDuplicate) {
              logger.info(
                `📝 Skipping metro memory storage - recent duplicate exists for ${first.name}`
              );
            } else {
              const memoryContent = `Metro save file analyzed: ${first.name}
Stats: ${result.analysis?.stats?.stations || 0} stations, ${result.analysis?.stats?.routes || 0} routes, ${result.analysis?.stats?.trains || 0} trains
Money: $${result.analysis?.stats?.money || 0}
Warnings: ${result.analysis?.warnings?.join('; ') || 'None'}
Status: Healthy - no repairs needed
File URL: ${url}`;
              await memoryService.remember(
                message.userId,
                memoryContent,
                'metro_analysis',
                7, // Importance
                undefined,
                memoryTags
              );
              logger.info(`📝 Stored metro analysis in memory for user ${message.userId}`);
            }
          } catch (memErr) {
            logger.warn(`Failed to store metro analysis in memory: ${memErr}`);
          }
        }
      } catch (error: any) {
        const errMsg = error?.message || String(error);
        const isTooLarge = /too large/i.test(errMsg);
        if (isTooLarge) {
          const note = `The .metro file is too large to analyze (over the size limit). Briefly tell the user it is too big and to send a smaller save.`;
          sources.push({
            name: 'metro_too_large',
            priority: 90,
            tokenWeight: estimateTokens(note),
            content: note,
            category: 'evidence',
          });
          logger.info('Metro file too large - friendly decline');
        } else {
          const msg = `Metro doctor failed: ${errMsg}`;
          sources.push({
            name: 'metro_doctor_error',
            priority: 60,
            tokenWeight: estimateTokens(msg),
            content: msg,
            category: 'system',
          });
          logger.warn(msg);
        }
      }
    }
  }

  // Resolved Discord message links - show the actual content of linked messages
  let resolvedDiscordMessages: any[] = [];
  if (Array.isArray(message.context?.resolvedDiscordMessages)) {
    resolvedDiscordMessages = message.context.resolvedDiscordMessages;
  }

  if (resolvedDiscordMessages.length > 0) {
    const lines = ['📨 Referenced Discord Messages:'];
    for (const msg of resolvedDiscordMessages) {
      lines.push(`\n**From @${msg.author} in #${msg.channel}:**`);
      lines.push(msg.content);
    }
    const content = lines.join('\n');
    sources.push({
      name: 'resolved_discord_messages',
      priority: 90, // Higher priority than regular URLs - these are explicitly referenced
      tokenWeight: estimateTokens(content),
      content,
      category: 'evidence',
    });
    logger.info(
      `📨 Added ${resolvedDiscordMessages.length} resolved Discord messages to context`
    );
  }

  // URLs from recent Discord context (non-attachments)
  if (recentUrls.length > 0) {
    const urlList = recentUrls.slice(0, 3);
    const lines = ['🔗 Recent URLs:', ...urlList.map((u: any) => `- ${u}`)];
    const content = lines.join('\n');
    sources.push({
      name: 'recent_urls',
      priority: 85,
      tokenWeight: estimateTokens(content),
      content,
      category: 'evidence',
    });

    const autoLinkFetch = (process.env.AUTO_LINK_FETCH || 'true').toLowerCase() !== 'false';

    if (autoLinkFetch) {
      const previews: string[] = [];
      for (const url of urlList) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const resp = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          const contentType = resp.headers.get('content-type') || '';
          if (!resp.ok) {
            previews.push(`🔗 ${url}\n⚠️ Fetch failed: ${resp.status} ${resp.statusText}`);
            continue;
          }
          if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
            previews.push(`🔗 ${url}\n(ignored non-text content-type: ${contentType})`);
            continue;
          }

          const text = await resp.text();
          const MAX_CHARS = 2000;
          const trimmed = text.slice(0, MAX_CHARS);

          const titleMatch = trimmed.match(/<title>([^<]{0,200})<\/title>/i);
          let title = '';
          if (titleMatch) {
            title = titleMatch[1].trim();
          }

          const plain = collapseWhitespace(
            trimmed
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
          )
            .trim()
            .slice(0, 600);

          let summary: string;
          if (title) {
            summary = `Title: ${title}\nPreview: ${plain || '(empty)'}`;
          } else {
            summary = `Preview: ${plain || '(empty)'}`;
          }

          previews.push(`🔗 ${url}\n${summary}`);
        } catch (error: any) {
          previews.push(`🔗 ${url}\n⚠️ Fetch failed: ${error?.message || String(error)}`);
        }
      }

      if (previews.length > 0) {
        const content = ['🔎 Auto link previews (recent URLs):', ...previews].join('\n\n');
        sources.push({
          name: 'recent_urls_auto',
          priority: 84, // just below the URL list
          tokenWeight: estimateTokens(content),
          content,
          category: 'evidence',
        });
      }
    }
  }
}

/**
 * Add stored file context - reads analysis from /tmp/artie-analysis/{userId}.txt
 * Simple file-based approach for follow-up questions
 */
export async function addStoredFileContext(
  message: IncomingMessage,
  sources: ContextSource[]
): Promise<void> {
  try {
    const analysis = readAnalysis(message.userId);

    if (analysis) {
      const content = `PREVIOUS ANALYSIS (${analysis.age}min ago) - ${analysis.filename}:
${analysis.summary}`;

      sources.push({
        name: 'previous_analysis',
        priority: 96, // High priority - right before current attachments
        tokenWeight: estimateTokens(content),
        content,
        category: 'evidence',
      });

      if (DEBUG) {
        logger.info(
          `│ ✅ Loaded previous analysis: ${analysis.filename} (${analysis.age}min old)`
        );
      }
    }
  } catch (error) {
    logger.warn('Failed to read analysis file:', error);
  }
}

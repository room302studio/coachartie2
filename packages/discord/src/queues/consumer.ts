import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  SelectMenuBuilder,
  ModalBuilder,
} from 'discord.js';
import {
  createWorker,
  QUEUES,
  OutgoingMessage,
  logger,
  testRedisConnection,
} from '@coachartie/shared';
import type { Worker } from 'bullmq';

// Known users Artie often means to actually PING but writes as plain text ("@ejfox"),
// which doesn't notify anyone. Convert those to real Discord mentions on the way out.
// (allowedMentions parse:['users'] on the client means <@id> genuinely notifies them.)
const KNOWN_MENTIONS: Record<string, string> = {
  ejfox: '688448399879438340',
};

function resolveKnownMentions(text: string): string {
  // Match @name not already part of a <@id> mention or a word/email.
  return text.replace(/(?<![<\w/])@([a-z0-9_]+)/gi, (whole, name: string) => {
    const id = KNOWN_MENTIONS[name.toLowerCase()];
    return id ? `<@${id}>` : whole;
  });
}

// De-duplication ledger for outbound sends, keyed by inbound message id (inReplyTo).
// Bounded + time-windowed: resubmits arrive within seconds/minutes of the original.
const SENT_TTL_MS = 10 * 60 * 1000; // 10 min covers any timeout-driven resubmit
const recentlySent = new Map<string, number>(); // inReplyTo -> sent timestamp

function pruneSent(now: number): void {
  if (recentlySent.size < 1000) return;
  for (const [k, t] of recentlySent) {
    if (now - t > SENT_TTL_MS) recentlySent.delete(k);
  }
}

function wasRecentlySent(key: string): boolean {
  const t = recentlySent.get(key);
  return t !== undefined && Date.now() - t < SENT_TTL_MS;
}

function markSent(key: string): void {
  const now = Date.now();
  pruneSent(now);
  recentlySent.set(key, now);
}

function unmarkSent(key: string): void {
  recentlySent.delete(key);
}

export async function startResponseConsumer(
  client: Client
): Promise<Worker<OutgoingMessage> | null> {
  // Check Redis availability first
  const redisOk = await testRedisConnection();
  if (!redisOk) {
    logger.warn('⚠️ Discord response consumer: Redis unavailable - queue disabled');
    return null;
  }

  logger.info('✅ Discord response consumer: Redis available - starting worker');

  const worker = createWorker<OutgoingMessage, void>(QUEUES.OUTGOING_DISCORD, async (job) => {
    const response = job.data;

    // Idempotency: under load a job can exceed the 120s timeout and get resubmitted/retried,
    // producing a second OutgoingMessage for the SAME inbound message → the reply posts twice.
    // Suppress a send whose inReplyTo we already answered recently. (Keyed on inReplyTo, which
    // is unique per inbound message; skipped when absent so proactive/scheduled posts are unaffected.)
    const dedupeKey = response.inReplyTo;
    if (dedupeKey && wasRecentlySent(dedupeKey)) {
      logger.warn(`🛑 Duplicate response suppressed for message ${dedupeKey} (already answered)`);
      return;
    }

    try {
      // Get channel ID from the response metadata
      const channelId = response.metadata?.channelId;
      if (!channelId) {
        throw new Error('No channelId in response metadata');
      }

      // Find the channel
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        throw new Error(`Invalid channel: ${channelId}`);
      }

      // Claim this message right before sending; released on failure so a real send error
      // can still retry (only a successful send stays deduped).
      if (dedupeKey) markSent(dedupeKey);

      // Check if this is a special Discord UI response
      if (response.message.startsWith('DISCORD_UI:')) {
        await handleDiscordUIResponse(channel, response.message);
      } else {
        // Send regular text message (only if channel supports it)
        if ('send' in channel) {
          // Add debug instance identifier if enabled
          const debugInfo =
            process.env.ENABLE_INSTANCE_DEBUG === 'true'
              ? `\n\n_[${process.env.INSTANCE_NAME || 'unknown'}]_`
              : '';

          // Chunk the message to preserve formatting and respect Discord limits.
          // Resolve known plain-text @names to real pings so e.g. "@ejfox" actually notifies.
          const chunks = chunkMessage(resolveKnownMentions(response.message + debugInfo));
          for (const chunk of chunks) {
            await channel.send(chunk);
          }
        } else {
          throw new Error(`Channel type does not support sending messages: ${channel.type}`);
        }
      }

      logger.info(`Response sent to Discord channel ${channelId}`);
    } catch (error) {
      // Send failed — release the dedupe claim so a legitimate retry can go through.
      if (dedupeKey) unmarkSent(dedupeKey);
      logger.error(`Failed to send Discord response for message ${response.inReplyTo}:`, error);
      throw error; // Let BullMQ handle retries
    }
  });

  worker.on('completed', (job) => {
    logger.info(`Discord response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Discord response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  return worker;
}

/**
 * Handle special Discord UI responses (modals, buttons, select menus)
 */
async function handleDiscordUIResponse(channel: any, message: string): Promise<void> {
  try {
    // Parse the special format: DISCORD_UI:TYPE:JSON_DATA:USER_MESSAGE
    const parts = message.split(':');
    if (parts.length < 4) {
      throw new Error('Invalid Discord UI response format');
    }

    const type = parts[1]; // MODAL, BUTTONS, SELECT, CONTEXT_MENU
    const jsonData = parts.slice(2, -1).join(':'); // Handle JSON with colons
    const userMessage = parts[parts.length - 1]; // The readable message

    const uiData = JSON.parse(jsonData);

    switch (type) {
      case 'BUTTONS':
        await sendButtonMessage(channel, userMessage, uiData);
        break;

      case 'SELECT':
        await sendSelectMessage(channel, userMessage, uiData);
        break;

      case 'MODAL':
        // Modals can't be sent directly, they need to be triggered by interactions
        // For now, just send a message explaining what was created
        await sendModalInfo(channel, userMessage, uiData);
        break;

      case 'CONTEXT_MENU':
        // Context menus need to be registered as application commands
        await sendContextMenuInfo(channel, userMessage, uiData);
        break;

      default:
        logger.warn(`Unknown Discord UI type: ${type}`);
        if ('send' in channel) {
          await channel.send(userMessage);
        }
    }

    logger.info(`Discord UI component sent:`, { type, channel: channel.id });
  } catch (error) {
    logger.error('Failed to handle Discord UI response:', error);
    // Fallback: send the user message part
    const fallbackMessage = message.split(':').pop() || 'Discord UI component created!';
    if ('send' in channel) {
      await channel.send(fallbackMessage);
    }
  }
}

async function sendButtonMessage(channel: any, userMessage: string, uiData: any): Promise<void> {
  if (!('send' in channel)) return;

  // Reconstruct ActionRows from the JSON data
  const actionRows = uiData.actionRows.map(
    (rowData: any) => ActionRowBuilder.from(rowData) as ActionRowBuilder<ButtonBuilder>
  );

  await channel.send({
    content: userMessage,
    components: actionRows,
  });
}

async function sendSelectMessage(channel: any, userMessage: string, uiData: any): Promise<void> {
  if (!('send' in channel)) return;

  // Reconstruct ActionRow with SelectMenu from JSON data
  const actionRow = ActionRowBuilder.from(uiData.actionRow) as ActionRowBuilder<SelectMenuBuilder>;

  await channel.send({
    content: userMessage,
    components: [actionRow],
  });
}

async function sendModalInfo(channel: any, userMessage: string, uiData: any): Promise<void> {
  if (!('send' in channel)) return;

  // Modals can't be sent directly - they need to be shown in response to interactions
  // For now, send info about the modal that was created
  await channel.send({
    content: `📝 ${userMessage}\n\n*Note: Modals appear when you interact with buttons or slash commands that trigger them.*`,
  });
}

async function sendContextMenuInfo(channel: any, userMessage: string, uiData: any): Promise<void> {
  if (!('send' in channel)) return;

  // Context menus need to be registered as application commands
  await channel.send({
    content: `🖱️ ${userMessage}\n\n*Note: Context menus need to be registered with Discord. Use a slash command to register this context menu.*`,
  });
}

/**
 * Split long messages into Discord-compatible chunks
 * Preserves newlines and markdown formatting
 */
function chunkMessage(text: string, maxLength: number = 2000): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = '';

  // Split on double newlines to find paragraphs, but keep the delimiters
  const paragraphParts = text.split(/(\n\n+)/);

  for (const part of paragraphParts) {
    // Check if this is a paragraph delimiter (double+ newlines)
    const isDelimiter = /^\n\n+$/.test(part);

    if (isDelimiter) {
      // Preserve paragraph breaks - normalize to double newline
      if (currentChunk.length + 2 <= maxLength) {
        currentChunk += '\n\n';
      } else {
        // Flush and start fresh
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trimEnd());
          currentChunk = '';
        }
      }
      continue;
    }

    // Regular paragraph content - preserve single newlines within it
    const lines = part.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // Don't trim - preserve leading whitespace for indentation

      // Calculate what we need to add
      const needsNewline = currentChunk.length > 0 && lineIdx > 0;
      const addition = (needsNewline ? '\n' : '') + line;

      // If adding this line fits, add it
      if (currentChunk.length + addition.length <= maxLength) {
        currentChunk += addition;
        continue;
      }

      // Line won't fit - flush current chunk first
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trimEnd());
        currentChunk = '';
      }

      // If line itself fits, use it
      if (line.length <= maxLength) {
        currentChunk = line;
        continue;
      }

      // Line is too long - must split by words
      const words = line.split(' ');

      for (const word of words) {
        if (currentChunk.length + word.length + 1 > maxLength) {
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trimEnd());
            currentChunk = '';
          }

          // If single word is too long, split it
          if (word.length > maxLength) {
            for (let i = 0; i < word.length; i += maxLength) {
              chunks.push(word.slice(i, i + maxLength));
            }
          } else {
            currentChunk = word;
          }
        } else {
          currentChunk += (currentChunk ? ' ' : '') + word;
        }
      }
    }
  }

  // Flush any remaining content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd());
  }

  return chunks.length > 0 ? chunks : [text];
}

import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import crypto from 'crypto';
import * as gateway from '../../gateway/api.js';
import { withTimeout } from '../../shared/async.js';
import { isEmail } from '../../shared/email.js';

export const sbatRouter: ReturnType<typeof Router> = Router();

const SBAT_DISCORD_CHANNEL = '1480985884676587620'; // #subwaybuilder-sbat in Room 302

// Simple in-memory rate limiter
const rateLimiter = {
  timestamps: [] as number[],
  maxPerMinute: 10,
  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  },
};

/**
 * Verify MailerSend webhook signature (timing-safe)
 */
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Post a message to the SBAT Discord channel
 */
async function postToDiscord(content: string): Promise<string | null> {
  try {
    // The gateway's POST /api/channels/:id/messages, in-process since wave 9 (was an HTTP
    // POST to the gateway on :47321 with a 10s timeout, which threw on any non-2xx).
    const resp = await withTimeout(
      gateway.sendChannelMessage(SBAT_DISCORD_CHANNEL, { content }),
      10000
    );
    if (!gateway.isOk(resp)) throw new Error(`Request failed with status code ${resp.status}`);
    return resp.body?.id || null;
  } catch (e) {
    logger.error('SBAT: Failed to post to Discord:', e);
    return null;
  }
}

/**
 * Detect priority from subject/body keywords
 */
function detectPriority(subject: string, body: string): string {
  const text = (subject + ' ' + body).toLowerCase();
  if (text.match(/\b(urgent|emergency|crash|data.?loss|can'?t play|broken)\b/)) return 'high';
  if (text.match(/\b(bug|error|issue|problem|not working|won'?t)\b/)) return 'normal';
  if (text.match(/\b(suggestion|idea|feature|request|would be nice)\b/)) return 'low';
  return 'normal';
}

/**
 * Map priority to emoji
 */
function priorityEmoji(priority: string): string {
  if (priority === 'high') {
    return '🔴';
  }
  if (priority === 'low') {
    return '🟢';
  }
  return '🟡';
}

/**
 * Format sender name with email
 */
function formatFromField(name: string, email: string): string {
  if (name) {
    return `${name} <${email}>`;
  }
  return email;
}

/**
 * Format preview text with quote prefix
 */
function formatPreview(text: string): string {
  if (text) {
    return `> ${text.replace(/\n/g, '\n> ')}`;
  }
  return '*(empty body)*';
}

// =============================================================================
// POST /sbat/inbound-email — MailerSend inbound webhook → Discord relay
// =============================================================================
sbatRouter.post('/inbound-email', async (req: Request, res: Response) => {
  const webhookSecret = process.env.SBAT_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn('SBAT: Rejecting inbound email — SBAT_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-mailersend-signature'] as string;
  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    logger.warn('SBAT: Signature verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!rateLimiter.check()) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const data = req.body;

    const fromEmail =
      data.from?.email || data.sender?.email || data.from_email || '';
    const fromName =
      data.from?.name || data.sender?.name || data.from_name || '';
    const subject = (data.subject || '(no subject)').substring(0, 500);
    const bodyText = (data.text || data.body_text || data.body || '').substring(0, 50_000);

    if (!fromEmail || !isEmail(fromEmail)) {
      return res.status(400).json({ error: 'Invalid sender email' });
    }

    const priority = detectPriority(subject, bodyText);
    const emojiIcon = priorityEmoji(priority);
    const previewText = bodyText.substring(0, 300);
    let preview: string;
    if (bodyText.length > 300) {
      preview = previewText + '...';
    } else {
      preview = previewText;
    }

    const discordMsg = [
      `## ${emojiIcon} Inbound Email`,
      `**From:** ${formatFromField(fromName, fromEmail)}`,
      `**Subject:** ${subject}`,
      `**Priority:** ${priority}`,
      '',
      formatPreview(preview),
    ].join('\n');

    await postToDiscord(discordMsg);

    logger.info(`📩 SBAT: Relayed email "${subject}" from ${fromEmail} to Discord`);

    res.json({ success: true });
  } catch (error) {
    logger.error('SBAT: Failed to relay inbound email:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import crypto from 'crypto';
import axios from 'axios';

export const sbatRouter: ReturnType<typeof Router> = Router();

const SBAT_DISCORD_CHANNEL = '1480985884676587620'; // #subwaybuilder-sbat in Room 302
const DISCORD_API = 'http://127.0.0.1:47321/api';

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
    const resp = await axios.post(
      `${DISCORD_API}/channels/${SBAT_DISCORD_CHANNEL}/messages`,
      { content },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return resp.data?.id || null;
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

    if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      return res.status(400).json({ error: 'Invalid sender email' });
    }

    const priority = detectPriority(subject, bodyText);
    const priorityEmoji =
      priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
    const preview = bodyText.substring(0, 300) + (bodyText.length > 300 ? '...' : '');

    const discordMsg = [
      `## ${priorityEmoji} Inbound Email`,
      `**From:** ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
      `**Subject:** ${subject}`,
      `**Priority:** ${priority}`,
      '',
      preview ? `> ${preview.replace(/\n/g, '\n> ')}` : '*(empty body)*',
    ].join('\n');

    await postToDiscord(discordMsg);

    logger.info(`📩 SBAT: Relayed email "${subject}" from ${fromEmail} to Discord`);

    res.json({ success: true });
  } catch (error) {
    logger.error('SBAT: Failed to relay inbound email:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

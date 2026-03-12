import { Router, Request, Response } from 'express';
import { logger, getSyncDb } from '@coachartie/shared';
import crypto from 'crypto';
import axios from 'axios';

export const sbatRouter: ReturnType<typeof Router> = Router();

const SBAT_DISCORD_CHANNEL = '1480985884676587620'; // #subwaybuilder-sbat in Room 302
const DISCORD_API = 'http://127.0.0.1:47321/api';

const VALID_STATUSES = new Set(['open', 'in_progress', 'resolved', 'closed']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

// Simple in-memory rate limiter for inbound endpoint
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
 * Validate ticket number format: SBAT-NNNN
 */
function isValidTicketNumber(tn: string): boolean {
  return /^SBAT-\d{4,}$/.test(tn);
}

/**
 * Generate next ticket number: SBAT-0001, SBAT-0002, etc.
 */
function getNextTicketNumber(): string {
  const db = getSyncDb();
  const row = db.get<{ max_num: number | null }>(
    "SELECT MAX(CAST(REPLACE(ticket_number, 'SBAT-', '') AS INTEGER)) as max_num FROM support_tickets"
  );
  const next = (row?.max_num || 0) + 1;
  return `SBAT-${String(next).padStart(4, '0')}`;
}

/**
 * Ensure support_tickets table exists
 */
function ensureTable(): void {
  const db = getSyncDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL UNIQUE,
      from_email TEXT NOT NULL,
      from_name TEXT DEFAULT '',
      subject TEXT NOT NULL,
      body_text TEXT DEFAULT '',
      body_html TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      assignee TEXT,
      discord_thread_id TEXT,
      priority TEXT DEFAULT 'normal',
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    )
  `);
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_support_tickets_number ON support_tickets(ticket_number)'
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)'
  );
}

// Ensure table on module load
try {
  ensureTable();
} catch (e) {
  logger.warn('SBAT: Could not ensure support_tickets table on load:', e);
}

/**
 * Verify MailerSend webhook signature (timing-safe)
 */
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  // Length check first — timingSafeEqual throws on mismatched lengths
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
// POST /sbat/inbound-email — MailerSend inbound webhook
// =============================================================================
sbatRouter.post('/inbound-email', async (req: Request, res: Response) => {
  const webhookSecret = process.env.SBAT_WEBHOOK_SECRET;

  // Require webhook secret in production — open endpoint is a spam vector
  if (!webhookSecret) {
    logger.warn('SBAT: Rejecting inbound email — SBAT_WEBHOOK_SECRET not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  // Verify MailerSend signature
  const signature = req.headers['x-mailersend-signature'] as string;
  if (!signature) {
    logger.warn('SBAT: Inbound email missing signature header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Use raw body for signature verification when available, fall back to re-serialized
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    logger.warn('SBAT: Inbound email signature verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limit
  if (!rateLimiter.check()) {
    logger.warn('SBAT: Rate limit exceeded on inbound email');
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
    const bodyHtml = (data.html || data.body_html || '').substring(0, 100_000);

    if (!fromEmail) {
      return res.status(400).json({ error: 'Missing sender email' });
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      return res.status(400).json({ error: 'Invalid sender email' });
    }

    const ticketNumber = getNextTicketNumber();
    const priority = detectPriority(subject, bodyText);

    const db = getSyncDb();
    db.run(
      `INSERT INTO support_tickets (ticket_number, from_email, from_name, subject, body_text, body_html, priority, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticketNumber, fromEmail, fromName.substring(0, 200), subject, bodyText, bodyHtml, priority,
       JSON.stringify({ received_at: new Date().toISOString() })]
    );

    logger.info(
      `📩 SBAT Ticket ${ticketNumber}: "${subject}" from ${fromName} <${fromEmail}> [${priority}]`
    );

    // Post to Discord
    const priorityEmoji =
      priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
    const preview = bodyText.substring(0, 300) + (bodyText.length > 300 ? '...' : '');

    const discordMsg = [
      `## ${priorityEmoji} New Ticket: ${ticketNumber}`,
      `**From:** ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
      `**Subject:** ${subject}`,
      `**Priority:** ${priority}`,
      '',
      preview ? `> ${preview.replace(/\n/g, '\n> ')}` : '*(empty body)*',
      '',
      `Reply here to discuss. Use \`/sbat close ${ticketNumber}\` when resolved.`,
    ].join('\n');

    await postToDiscord(discordMsg);

    res.json({
      success: true,
      ticket: ticketNumber,
      priority,
      message: `Ticket ${ticketNumber} created`,
    });
  } catch (error) {
    logger.error('SBAT: Failed to process inbound email:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================================================
// GET /sbat/tickets — List tickets
// =============================================================================
sbatRouter.get('/tickets', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const db = getSyncDb();

    let tickets;
    if (status) {
      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: `Invalid status. Valid: ${[...VALID_STATUSES].join(', ')}` });
      }
      tickets = db.all<Record<string, unknown>>(
        'SELECT id, ticket_number, from_email, from_name, subject, status, assignee, priority, created_at, updated_at, resolved_at FROM support_tickets WHERE status = ? ORDER BY created_at DESC LIMIT 50',
        [status]
      );
    } else {
      tickets = db.all<Record<string, unknown>>(
        'SELECT id, ticket_number, from_email, from_name, subject, status, assignee, priority, created_at, updated_at, resolved_at FROM support_tickets ORDER BY created_at DESC LIMIT 50'
      );
    }

    res.json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    logger.error('SBAT: Failed to list tickets:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================================================
// GET /sbat/tickets/:ticketNumber — Get single ticket
// =============================================================================
sbatRouter.get('/tickets/:ticketNumber', async (req: Request, res: Response) => {
  try {
    if (!isValidTicketNumber(req.params.ticketNumber)) {
      return res.status(400).json({ error: 'Invalid ticket number format' });
    }

    const db = getSyncDb();
    const ticket = db.get<Record<string, unknown>>(
      'SELECT * FROM support_tickets WHERE ticket_number = ?',
      [req.params.ticketNumber]
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ success: true, ticket });
  } catch (error) {
    logger.error('SBAT: Failed to get ticket:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// =============================================================================
// PATCH /sbat/tickets/:ticketNumber — Update ticket status/assignee
// =============================================================================
sbatRouter.patch('/tickets/:ticketNumber', async (req: Request, res: Response) => {
  try {
    if (!isValidTicketNumber(req.params.ticketNumber)) {
      return res.status(400).json({ error: 'Invalid ticket number format' });
    }

    const { status, assignee, priority } = req.body;

    // Validate enum fields
    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${[...VALID_STATUSES].join(', ')}` });
    }
    if (priority && !VALID_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: `Invalid priority. Valid: ${[...VALID_PRIORITIES].join(', ')}` });
    }
    if (assignee !== undefined && typeof assignee !== 'string') {
      return res.status(400).json({ error: 'Assignee must be a string or null' });
    }

    const db = getSyncDb();

    const ticket = db.get<Record<string, unknown>>(
      'SELECT * FROM support_tickets WHERE ticket_number = ?',
      [req.params.ticketNumber]
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (status) {
      updates.push('status = ?');
      values.push(status);
      if (status === 'resolved' || status === 'closed') {
        updates.push('resolved_at = CURRENT_TIMESTAMP');
      }
    }
    if (assignee !== undefined) {
      updates.push('assignee = ?');
      values.push(assignee ? assignee.substring(0, 100) : null);
    }
    if (priority) {
      updates.push('priority = ?');
      values.push(priority);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.ticketNumber);

    db.run(
      `UPDATE support_tickets SET ${updates.join(', ')} WHERE ticket_number = ?`,
      values as any[]
    );

    logger.info(`📩 SBAT Ticket ${req.params.ticketNumber} updated: status=${status || '-'}, priority=${priority || '-'}, assignee=${assignee ?? '-'}`);

    res.json({ success: true, message: `Ticket ${req.params.ticketNumber} updated` });
  } catch (error) {
    logger.error('SBAT: Failed to update ticket:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

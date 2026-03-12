import { Router, Request, Response } from 'express';
import { logger, getSyncDb } from '@coachartie/shared';
import crypto from 'crypto';
import axios from 'axios';

export const sbatRouter: ReturnType<typeof Router> = Router();

const SBAT_DISCORD_CHANNEL = '1480985884676587620'; // #subwaybuilder-sbat in Room 302
const DISCORD_API = 'http://127.0.0.1:47321/api';

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
 * Verify MailerSend webhook signature
 */
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
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

  // Verify signature if secret is configured
  if (webhookSecret) {
    const signature = req.headers['x-mailersend-signature'] as string;
    if (!signature) {
      logger.warn('SBAT: Inbound email missing signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const rawBody = JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature, webhookSecret)) {
      logger.warn('SBAT: Inbound email signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    // MailerSend inbound email payload
    // Supports both MailerSend format and a simple generic format
    const data = req.body;

    const fromEmail =
      data.from?.email || data.sender?.email || data.from_email || '';
    const fromName =
      data.from?.name || data.sender?.name || data.from_name || '';
    const subject = data.subject || '(no subject)';
    const bodyText = data.text || data.body_text || data.body || '';
    const bodyHtml = data.html || data.body_html || '';

    if (!fromEmail) {
      return res.status(400).json({ error: 'Missing sender email' });
    }

    const ticketNumber = getNextTicketNumber();
    const priority = detectPriority(subject, bodyText);

    // Store in DB
    const db = getSyncDb();
    db.run(
      `INSERT INTO support_tickets (ticket_number, from_email, from_name, subject, body_text, body_html, priority, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticketNumber, fromEmail, fromName, subject, bodyText, bodyHtml, priority,
       JSON.stringify({ raw: data, received_at: new Date().toISOString() })]
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
    res.status(500).json({
      error: 'Failed to process email',
      details: error instanceof Error ? error.message : String(error),
    });
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
      tickets = db.all<Record<string, unknown>>(
        'SELECT * FROM support_tickets WHERE status = ? ORDER BY created_at DESC LIMIT 50',
        [status]
      );
    } else {
      tickets = db.all<Record<string, unknown>>(
        'SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 50'
      );
    }

    res.json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list tickets',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// =============================================================================
// GET /sbat/tickets/:ticketNumber — Get single ticket
// =============================================================================
sbatRouter.get('/tickets/:ticketNumber', async (req: Request, res: Response) => {
  try {
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
    res.status(500).json({
      error: 'Failed to get ticket',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// =============================================================================
// PATCH /sbat/tickets/:ticketNumber — Update ticket status/assignee
// =============================================================================
sbatRouter.patch('/tickets/:ticketNumber', async (req: Request, res: Response) => {
  try {
    const { status, assignee, priority } = req.body;
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
      values.push(assignee);
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

    logger.info(`📩 SBAT Ticket ${req.params.ticketNumber} updated: ${JSON.stringify(req.body)}`);

    res.json({ success: true, message: `Ticket ${req.params.ticketNumber} updated` });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update ticket',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

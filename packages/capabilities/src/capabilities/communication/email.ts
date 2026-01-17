import { logger } from '@coachartie/shared';
import axios from 'axios';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

/**
 * Email capability for sending emails via self-hosted infrastructure
 *
 * Provides functionality to:
 * - Send emails via n8n webhook (production)
 * - Send emails via MailDev (local development)
 * - Send emails via VPS SMTP (direct, when IP has reputation)
 *
 * Email-writing mode is implemented in capability-orchestrator.ts:
 * - Detects email intent from user messages
 * - Drafts emails using Claude Sonnet
 * - Shows drafts for approval/revision
 * - Handles send/edit/cancel workflow
 */

interface EmailPayload {
  to: string;
  from?: string;
  subject: string;
  body: string;
}

class EmailService {
  private webhookUrl: string | null = null;
  private webhookAuth: string | null = null;

  constructor() {
    // Load n8n webhook configuration if available
    this.webhookUrl = process.env.EMAIL_WEBHOOK_URL || null;
    this.webhookAuth = process.env.EMAIL_WEBHOOK_AUTH || null;
  }

  /**
   * Send email via appropriate transport
   */
  async send(payload: EmailPayload): Promise<{ success: boolean; message: string }> {
    try {
      // Validate inputs
      if (!payload.to || !payload.subject || !payload.body) {
        throw new Error('Missing required fields: to, subject, and body are required');
      }

      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(payload.to)) {
        throw new Error(
          `Invalid email address: ${payload.to}\n\nExample: <capability name="email" action="send" to="user@example.com" subject="Test" body="Hello!" />`
        );
      }

      // Use n8n webhook if configured (production path)
      if (this.webhookUrl && this.webhookAuth) {
        logger.info(`📧 Sending email via n8n webhook to ${payload.to}`);
        return await this.sendViaWebhook(payload);
      }

      // Fallback to direct SMTP (local dev or VPS)
      logger.info(`📧 Sending email via direct SMTP to ${payload.to}`);
      return await this.sendViaSMTP(payload);
    } catch (error) {
      logger.error('❌ Failed to send email:', error);
      return {
        success: false,
        message: `Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Send email via n8n webhook
   */
  private async sendViaWebhook(
    payload: EmailPayload
  ): Promise<{ success: boolean; message: string }> {
    try {
      const response = await axios.post(
        this.webhookUrl!,
        {
          to: payload.to,
          from: payload.from || 'artie@coachartiebot.com',
          subject: payload.subject,
          body: payload.body,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            coachartie: this.webhookAuth!,
          },
          timeout: 10000, // 10 second timeout
        }
      );

      if (response.status === 200 || response.data?.message?.includes('started')) {
        logger.info(`✅ Email sent successfully via webhook to ${payload.to}`);
        return {
          success: true,
          message: `Email sent to ${payload.to}`,
        };
      }

      throw new Error(`Webhook returned unexpected status: ${response.status}`);
    } catch (error) {
      logger.error('❌ Webhook email send failed:', error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Webhook failed: ${error.response?.data?.message || error.message}\n\nCheck email webhook configuration (EMAIL_WEBHOOK_URL and EMAIL_WEBHOOK_AUTH)`
        );
      }
      throw error;
    }
  }

  /**
   * Send email via direct SMTP (MailDev for local, or VPS SMTP)
   */
  private async sendViaSMTP(payload: EmailPayload): Promise<{ success: boolean; message: string }> {
    // Detect environment outside try block so it's accessible in catch
    const isDev = process.env.NODE_ENV === 'development';

    try {
      // Import nodemailer dynamically
      const nodemailer = await import('nodemailer');
      const host = isDev ? 'localhost' : process.env.EMAIL_HOST || 'mail.coachartiebot.com';
      const port = isDev ? 1025 : parseInt(process.env.EMAIL_PORT || '587');

      // Create transporter
      const transporter = nodemailer.default.createTransport({
        host,
        port,
        secure: port === 465,
        ignoreTLS: isDev, // MailDev doesn't need TLS
        auth: isDev
          ? undefined
          : {
              user: process.env.EMAIL_USER || 'artie@coachartiebot.com',
              pass: process.env.EMAIL_PASS || '',
            },
      });

      // Send email
      const info = await transporter.sendMail({
        from: payload.from || 'Coach Artie <artie@coachartiebot.com>',
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      });

      logger.info(`✅ Email sent via SMTP to ${payload.to}, messageId: ${info.messageId}`);

      return {
        success: true,
        message: isDev
          ? `Email sent to ${payload.to} (captured in MailDev at http://localhost:47328)`
          : `Email sent to ${payload.to}`,
      };
    } catch (error) {
      logger.error('❌ SMTP email send failed:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const suggestion = isDev
        ? 'Is MailDev running on localhost:1025?'
        : `Check SMTP configuration: EMAIL_HOST=${process.env.EMAIL_HOST}, EMAIL_PORT=${process.env.EMAIL_PORT}`;
      throw new Error(`SMTP failed: ${errorMsg}\n\n${suggestion}`);
    }
  }

  /**
   * Get email system status
   */
  getStatus(): string {
    const isDev = process.env.NODE_ENV === 'development';
    const hasWebhook = !!(this.webhookUrl && this.webhookAuth);

    let status = 'Email System Status:\n';
    status += `🌍 Environment: ${isDev ? 'Development' : 'Production'}\n`;

    if (hasWebhook) {
      status += `📡 Transport: n8n webhook (configured)\n`;
      status += `🔗 Webhook: ${this.webhookUrl}\n`;
    } else if (isDev) {
      status += `📡 Transport: MailDev (localhost:1025)\n`;
      status += `🌐 Web UI: http://localhost:47328\n`;
    } else {
      status += `📡 Transport: Direct SMTP\n`;
      status += `🖥️ Server: ${process.env.EMAIL_HOST || 'mail.coachartiebot.com'}\n`;
    }

    status += `✉️ From: ${process.env.EMAIL_FROM || 'artie@coachartiebot.com'}\n`;
    status += `✅ Ready: ${hasWebhook || isDev ? 'Yes' : 'Yes (may be rejected by Gmail until IP builds reputation)'}`;

    return status;
  }
}

// Singleton service instance
let emailService: EmailService | null = null;

/**
 * Get or create email service
 */
function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService();
  }
  return emailService;
}

/**
 * Email capability handler
 */
async function handleEmailCapability(params: any, content?: string): Promise<string> {
  const { action, to, subject, from } = params;
  const service = getEmailService();

  try {
    if (!action) {
      throw new Error('action is required. Available actions: send, status');
    }

    switch (action) {
      case 'send': {
        const body = content || params.body;

        if (!to) {
          throw new Error('Recipient email address (to) is required');
        }
        if (!subject) {
          throw new Error('Email subject is required');
        }
        if (!body) {
          throw new Error('Email body is required');
        }

        logger.info(`📧 Email capability invoked: to=${to}, subject="${subject}"`);

        const result = await service.send({ to, from, subject, body });

        if (result.success) {
          return `✅ ${result.message}\n\n📝 Sent:\nTo: ${to}\nSubject: ${subject}\n\nBody:\n${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`;
        }

        throw new Error(result.message);
      }

      case 'status':
        return service.getStatus();

      default:
        throw new Error(`Unknown email action: ${action}. Available actions: send, status`);
    }
  } catch (error) {
    logger.error(`❌ Email capability error:`, error);
    throw error;
  }
}

/**
 * Email capability registration
 */
export const emailCapability: RegisteredCapability = {
  name: 'email',
  emoji: '📧',
  supportedActions: ['send', 'status'],
  handler: handleEmailCapability,
  description: 'Send emails via self-hosted infrastructure or n8n webhook bridge',
  examples: [
    '<capability name="email" action="send" to="user@example.com" subject="Quick Question">Hi! Just wanted to follow up about the meeting...</capability>',
    '<capability name="email" action="send" to="team@company.com" subject="Project Update">Here\'s the latest update on the project progress...</capability>',
    '<capability name="email" action="status" />',
  ],
};

export { EmailService, getEmailService };

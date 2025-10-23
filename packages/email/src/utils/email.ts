import nodemailer from 'nodemailer';
import { logger } from '@coachartie/shared';

let emailTransporter: nodemailer.Transporter | null = null;

export function getEmailTransporter(): nodemailer.Transporter {
  if (!emailTransporter) {
    const host = process.env.EMAIL_HOST;
    const port = parseInt(process.env.EMAIL_PORT || '587');
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!host || !user || !pass) {
      throw new Error(
        'Missing email configuration: EMAIL_HOST, EMAIL_USER, and EMAIL_PASS required'
      );
    }

    emailTransporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for other ports
      auth: {
        user,
        pass,
      },
    });

    logger.info('Email transporter initialized', { host, port, user });
  }

  return emailTransporter!;
}

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(options: EmailOptions): Promise<string> {
  try {
    const transporter = getEmailTransporter();
    const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER;

    if (!fromAddress) {
      throw new Error('Missing EMAIL_FROM or EMAIL_USER environment variable');
    }

    const mailOptions = {
      from: fromAddress,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    const result = await transporter.sendMail(mailOptions);

    logger.info(`Email sent successfully`, {
      to: options.to,
      subject: options.subject,
      messageId: result.messageId,
    });

    return result.messageId;
  } catch (error) {
    logger.error('Failed to send email:', error);
    throw error;
  }
}

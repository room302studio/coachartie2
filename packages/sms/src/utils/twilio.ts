import twilio from 'twilio';
import { logger } from '@coachartie/shared';

let twilioClient: twilio.Twilio | null = null;

export function getTwilioClient(): twilio.Twilio {
  // Always recreate client to pick up fresh environment variables
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error(
      'Missing Twilio credentials: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required'
    );
  }

  twilioClient = twilio(accountSid, authToken);
  logger.info('Twilio client initialized with SID:', accountSid);

  return twilioClient;
}

export async function sendSMS(to: string, message: string): Promise<string> {
  try {
    const client = getTwilioClient();
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber) {
      throw new Error('Missing TWILIO_PHONE_NUMBER environment variable');
    }

    const result = await client.messages.create({
      body: message,
      from: fromNumber,
      to: to,
    });

    logger.info(`SMS sent successfully`, {
      to: to.replace(/(\+\d{1,3})\d{6}(\d{4})/, '$1******$2'), // Mask phone number in logs
      messageSid: result.sid,
      status: result.status,
    });

    return result.sid;
  } catch (error) {
    logger.error('Failed to send SMS:', error);
    throw error;
  }
}

export async function sendVerificationSMS(to: string, code: string): Promise<string> {
  const message = `🤖 Your Coach Artie verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, please ignore.`;
  return sendSMS(to, message);
}

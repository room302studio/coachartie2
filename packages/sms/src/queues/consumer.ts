import { createWorker, QUEUES, OutgoingMessage, logger } from '@coachartie/shared';
import type { Worker } from 'bullmq';
import { sendSMS } from '../utils/twilio.js';

export async function startResponseConsumer(): Promise<Worker<OutgoingMessage>> {
  const worker = createWorker<OutgoingMessage, void>(QUEUES.OUTGOING_SMS, async (job) => {
    const response = job.data;

    try {
      // Get phone number from the response metadata
      const phoneNumber = response.metadata?.phoneNumber;
      if (!phoneNumber) {
        throw new Error('No phoneNumber in response metadata');
      }

      // Send SMS via Twilio
      const messageSid = await sendSMS(phoneNumber, response.message);

      logger.info(`SMS sent successfully`, {
        messageId: response.id,
        inReplyTo: response.inReplyTo,
        phoneNumber: phoneNumber,
        twilioSid: messageSid,
      });
    } catch (error) {
      logger.error(`Failed to send SMS for message ${response.inReplyTo}:`, error);
      throw error; // Let BullMQ handle retries
    }
  });

  worker.on('completed', (job) => {
    logger.info(`SMS response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`SMS response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  worker.on('error', (err) => {
    logger.error('SMS worker error:', err);
  });

  return worker;
}

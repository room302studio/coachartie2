import { createWorker, QUEUES, OutgoingMessage, logger } from '@coachartie/shared';
import type { Worker } from 'bullmq';
import { sendEmail } from '../utils/email.js';

export async function startResponseConsumer(): Promise<Worker<OutgoingMessage>> {
  const worker = createWorker<OutgoingMessage, void>(QUEUES.OUTGOING_EMAIL, async (job) => {
    const response = job.data;

    try {
      // Get email address from the response metadata
      const emailAddress = response.metadata?.emailAddress;
      if (!emailAddress) {
        throw new Error('No emailAddress in response metadata');
      }

      // Extract subject from context if available
      const originalSubject = response.metadata?.subject || 'Message from Coach Artie';
      const replySubject = originalSubject.startsWith('Re: ')
        ? originalSubject
        : `Re: ${originalSubject}`;

      // Send email
      const messageId = await sendEmail({
        to: emailAddress,
        subject: replySubject,
        text: response.message,
        html: `<p>${response.message.replace(/\n/g, '<br>')}</p>`,
      });

      logger.info(`Email sent successfully`, {
        messageId: response.id,
        inReplyTo: response.inReplyTo,
        emailAddress: emailAddress,
        emailMessageId: messageId,
      });
    } catch (error) {
      logger.error(`Failed to send email for message ${response.inReplyTo}:`, error);
      throw error; // Let BullMQ handle retries
    }
  });

  worker.on('completed', (job) => {
    logger.info(`Email response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Email response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  worker.on('error', (err) => {
    logger.error('Email worker error:', err);
  });

  return worker;
}

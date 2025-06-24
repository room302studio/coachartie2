import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

interface SMSWebhookData {
  from: string;
  to: string;
  body: string;
  messageSid: string;
}

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

export async function handleIncomingSMS(smsData: SMSWebhookData): Promise<void> {
  try {
    // Clean the phone number (remove +1 if present for US numbers)
    const cleanPhoneNumber = smsData.from.replace(/^\+1/, '');
    
    // Create queue message
    const queueMessage: IncomingMessage = {
      id: `sms-${smsData.messageSid}`,
      timestamp: new Date(),
      retryCount: 0,
      source: 'sms',
      userId: cleanPhoneNumber, // Use phone number as user ID
      message: smsData.body.trim(),
      context: {
        phoneNumber: smsData.from,
        twilioMessageSid: smsData.messageSid,
        platform: 'sms'
      },
      respondTo: {
        type: 'sms',
        phoneNumber: smsData.from
      }
    };

    // Send to capabilities queue for processing
    await messageQueue.add('process', queueMessage);
    
    logger.info(`SMS message queued for processing: ${queueMessage.id}`, {
      from: smsData.from,
      preview: smsData.body.substring(0, 50) + (smsData.body.length > 50 ? '...' : '')
    });

  } catch (error) {
    logger.error('Failed to queue SMS message:', error);
    throw error;
  }
}
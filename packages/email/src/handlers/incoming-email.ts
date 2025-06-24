import { createQueue, QUEUES, IncomingMessage, logger } from '@coachartie/shared';

interface EmailWebhookData {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}

const messageQueue = createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);

export async function handleIncomingEmail(emailData: EmailWebhookData): Promise<void> {
  try {
    // Extract email address (remove name if present)
    const emailMatch = emailData.from.match(/<(.+)>/) || [null, emailData.from];
    const senderEmail = emailMatch[1] || emailData.from;
    
    // Use text content, fallback to HTML without tags
    const messageBody = emailData.text || 
      (emailData.html ? emailData.html.replace(/<[^>]*>/g, '').trim() : '');
    
    if (!messageBody) {
      logger.warn('Empty email body received from:', senderEmail);
      return;
    }

    // Create queue message
    const queueMessage: IncomingMessage = {
      id: `email-${Date.now()}-${Math.random()}`,
      timestamp: new Date(),
      retryCount: 0,
      source: 'email',
      userId: senderEmail, // Use email as user ID
      message: messageBody.trim(),
      context: {
        emailAddress: senderEmail,
        subject: emailData.subject,
        platform: 'email',
        hasHtml: !!emailData.html
      },
      respondTo: {
        type: 'email',
        emailAddress: senderEmail
      }
    };

    // Send to capabilities queue for processing
    await messageQueue.add('process', queueMessage);
    
    logger.info(`Email message queued for processing: ${queueMessage.id}`, {
      from: senderEmail,
      subject: emailData.subject,
      preview: messageBody.substring(0, 100) + (messageBody.length > 100 ? '...' : '')
    });

  } catch (error) {
    logger.error('Failed to queue email message:', error);
    throw error;
  }
}
import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';
import {
  addPendingAttachment,
  getStoredMetroFile,
  clearStoredMetroFile,
} from '../../services/llm/pending-attachments.js';

export const sendMetroFileCapability: RegisteredCapability = {
  name: 'send-metro-file',
  emoji: '📎',
  supportedActions: ['send'],
  description:
    'Send the analyzed metro save file back to the user as a Discord attachment. ' +
    'Use this when the user uploaded a .metro file and you want to send it back ' +
    '(either the original analyzed version or a repaired version). ' +
    'The file must have been analyzed in this conversation. ' +
    'IMPORTANT: Do NOT make up download links - use this capability to actually send the file.',
  requiredParams: ['userId'],
  examples: [
    '<capability name="send-metro-file" action="send" userId="123456789" message="Here is your analyzed save file!" />',
    '<capability name="send-metro-file" action="send" userId="USER_ID">Sending your repaired metro file</capability>',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const { action } = params;

    switch (action) {
      case 'send':
        return JSON.stringify(await sendMetroFile(params));
      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Use action: "send"`,
        });
    }
  },
};

async function sendMetroFile(params: {
  userId?: string;
  message?: string;
}): Promise<any> {
  const { userId, message } = params;

  if (!userId) {
    return {
      success: false,
      error: 'Missing required parameter: userId',
    };
  }

  const stored = getStoredMetroFile(userId);
  if (!stored) {
    logger.warn(`📎 send-metro-file: No analyzed file found for user ${userId}`);
    return {
      success: false,
      error: 'No analyzed metro file available. The user needs to upload a .metro file first.',
    };
  }

  // Queue the file for sending
  addPendingAttachment(userId, {
    buffer: stored.buffer,
    filename: stored.filename,
    content: message || stored.summary,
  });

  logger.info(`📎 send-metro-file: Queued ${stored.filename} for user ${userId}`);

  // Clear from storage after queuing
  clearStoredMetroFile(userId);

  return {
    success: true,
    filename: stored.filename,
    size: stored.buffer.length,
    message: `File "${stored.filename}" will be sent as an attachment.`,
  };
}

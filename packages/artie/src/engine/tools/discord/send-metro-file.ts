import { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import {
  addPendingAttachment,
  getStoredMetroFile,
  clearStoredMetroFile,
} from '../../1-intake/pending-attachments.js';

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

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action } = params;

    switch (action) {
      case 'send':
        return JSON.stringify(await sendMetroFile({ ...params, turnId: context?.messageId }));
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
  turnId?: string;
}): Promise<any> {
  const { userId, message, turnId } = params;

  if (!userId) {
    return {
      success: false,
      error: 'Missing required parameter: userId',
    };
  }
  // The file rides on this turn's reply (2026-10-31); without a turn there's nothing to attach to.
  if (!turnId) {
    return {
      success: false,
      error: 'No reply to attach the file to (missing turn context).',
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
  addPendingAttachment(turnId, {
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

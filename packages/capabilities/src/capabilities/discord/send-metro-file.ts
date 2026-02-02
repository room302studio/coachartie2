import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Room 302 Studio Guild whitelist
const WHITELISTED_GUILD_IDS = ['932719842522443928'];

const DISCORD_SERVICE_URL = process.env.DISCORD_SERVICE_URL || 'http://localhost:47321';

export const sendMetroFileCapability: RegisteredCapability = {
  name: 'send-metro-file',
  emoji: '🚇',
  supportedActions: ['send_metro_file'],
  description:
    'Send a .metro file to a Discord channel. Used for sharing Subway Builder save files. Requires guildId, channelId, filename, and base64-encoded content.',
  requiredParams: ['guildId', 'channelId', 'filename', 'content'],

  handler: async (params: any, _content: string | undefined) => {
    const { action } = params;

    switch (action) {
      case 'send_metro_file':
        return JSON.stringify(await sendMetroFile(params));
      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
  },
};

/**
 * Send a .metro file to a Discord channel
 * Only allowed on whitelisted guilds
 */
async function sendMetroFile(params: {
  guildId?: string;
  channelId?: string;
  filename?: string;
  content?: string; // base64 encoded file content
  message?: string; // optional message to accompany the file
}): Promise<any> {
  const { guildId, channelId, filename, content, message } = params;

  // Validate required parameters
  if (!guildId || !channelId || !filename || !content) {
    logger.warn('❌ send-metro-file: Missing required parameters', {
      guildId,
      channelId,
      hasFilename: !!filename,
      hasContent: !!content,
    });
    return {
      success: false,
      error: 'Missing required parameters: guildId, channelId, filename, content',
      code: 'PARAM_MISSING',
    };
  }

  // Validate filename ends with .metro
  if (!filename.toLowerCase().endsWith('.metro')) {
    logger.warn('❌ send-metro-file: Invalid filename', { filename });
    return {
      success: false,
      error: 'Filename must end with .metro',
      code: 'INVALID_FILENAME',
    };
  }

  // Check guild whitelist
  if (!WHITELISTED_GUILD_IDS.includes(guildId)) {
    logger.warn('❌ send-metro-file: Guild not whitelisted', { guildId });
    return {
      success: false,
      error: `Guild ${guildId} is not whitelisted for sending files`,
      code: 'GUILD_NOT_WHITELISTED',
    };
  }

  try {
    // Decode base64 content to buffer
    const fileBuffer = Buffer.from(content, 'base64');

    // Create form data with file
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename,
      contentType: 'application/octet-stream',
    });

    if (message) {
      formData.append('content', message);
    }

    // Call Discord service to send file
    const response = await fetch(`${DISCORD_SERVICE_URL}/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error('❌ send-metro-file: Failed to send file', {
        status: response.status,
        error: errorData,
        channelId,
      });
      return {
        success: false,
        error: `Discord API error: ${response.status}`,
        details: errorData,
        code: 'DISCORD_API_ERROR',
      };
    }

    const sentMessage = await response.json();
    logger.info('✅ send-metro-file: File sent successfully', {
      channelId,
      messageId: (sentMessage as any).id,
      filename,
      size: fileBuffer.length,
    });

    return {
      success: true,
      messageId: (sentMessage as any).id,
      channelId,
      guildId,
      filename,
      size: fileBuffer.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ send-metro-file: Exception', {
      error: errorMessage,
      channelId,
      guildId,
      filename,
    });
    return {
      success: false,
      error: `Failed to send metro file: ${errorMessage}`,
      code: 'SEND_FILE_FAILED',
    };
  }
}

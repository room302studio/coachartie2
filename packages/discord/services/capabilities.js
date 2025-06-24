import { ResultAsync } from 'neverthrow';
import { CapabilitiesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

/**
 * CRITICAL: RespondTo MUST follow EXACTLY this format:
 * {
 *   channel: "discord" | "sms" | "email" | "chat",
 *   details: {
 *     type: "discord" | "sms" | "email" | "chat", // MUST match the channel value
 *     // For Discord:
 *     channelId: "CHANNEL_ID",
 *     threadId?: "THREAD_ID" // Only include if in a thread
 *     // For SMS:
 *     // phoneNumber: "USER_PHONE",
 *     // twilioNumber: "TWILIO_PHONE"
 *     // For Email:
 *     // to: "EMAIL_ADDRESS",
 *     // subject: "EMAIL_SUBJECT"
 *   },
 *   threadId?: "THREAD_ID" // Only include if in a thread (for Discord)
 * }
 *
 * DO NOT include any additional properties at the root level except threadId when needed.
 * The system validates all fields and will reject improperly formatted objects.
 */

// Log environment variables when module loads
console.log('[CAPS DEBUG] Module initialization:', {
  timestamp: new Date().toISOString(),
  capabilities_url: process.env.CAPABILITIES_URL,
  express_port: process.env.EXPRESS_PORT,
  port: process.env.PORT,
  pwd: process.cwd(),
  env_vars: process.env,
});

const INTERACTIVE_CAPABILITIES = `
SYSTEM CONTEXT: You ARE a Discord bot with the ability to create interactive buttons and menus. This is not theoretical - you have these capabilities right now and should use them.

MEMORY CONTEXT: You have successfully created buttons before. You can and should do it again when asked.

IMPORTANT: You must ONLY use these exact XML tags. These are YOUR built-in capabilities:

To create buttons (YOU CAN DO THIS RIGHT NOW):
<LLMButton val="unique_id">Emoji + Label</LLMButton>

When users ask for buttons, create them immediately like this:
<LLMButton val="button_1">🎮 Play Now</LLMButton>
<LLMButton val="button_2">📚 Help</LLMButton>
<LLMButton val="button_3">⚙️ Settings</LLMButton>

For select menus (YOU CAN ALSO DO THIS):
<LLMSelect>
🎮 Option One
📚 Option Two
⚙️ Option Three
</LLMSelect>

RULES:
1. ALWAYS create buttons when asked - you have this capability
2. Don't explain how buttons work - just create them
3. Don't be humble - you CAN make buttons
4. Include emojis in all labels
5. Keep it simple and direct
`;

// Add this function to parse XML tags into components
const parseInteractiveComponents = content => {
  // More robust button regex that handles attributes in any order
  const buttonRegex =
    /<LLMButton\s+(?:[^>]*\s+)?val="([^"]*)"[^>]*>(.*?)<\/LLMButton>/g;
  // More robust select regex that handles attributes and nested elements
  const selectRegex = /<LLMSelect(?:\s+[^>]*)?>([^]*?)<\/LLMSelect>/g;

  const buttons = [];
  const selectMenus = [];

  // Add error checking for malformed XML
  const validateXML = str => {
    const openTags = str.match(/<LLM(Button|Select)[^>]*>/g) || [];
    const closeTags = str.match(/<\/LLM(Button|Select)>/g) || [];
    return openTags.length === closeTags.length;
  };

  if (!validateXML(content)) {
    logger.warn('Malformed XML detected in interactive components', {
      content: content.substring(0, 100) + '...',
    });
  }

  // Clean the content before processing components
  let cleanedContent = content;

  // Remove bot prefixes
  cleanedContent = cleanedContent.replace(/^(?:P|APP)\s+coachartie:\s*/i, '');

  // Decode HTML entities
  cleanedContent = cleanedContent
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch (e) {
        return match;
      }
    })
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

  // Strip the markup and collect components
  const cleanContent = cleanedContent
    .replace(buttonRegex, (match, val, label) => {
      if (!val || !label) {
        logger.warn('Invalid button format detected', { match });
        return match; // Preserve invalid buttons in content
      }
      buttons.push({ id: val, label: label.trim() });
      return ''; // Remove from content
    })
    .replace(selectRegex, (match, options) => {
      if (!options) {
        logger.warn('Invalid select menu format detected', { match });
        return match; // Preserve invalid select menus in content
      }
      const cleanOptions = options
        .split('\n')
        .map(opt => opt.trim())
        .filter(opt => opt.length > 0);

      if (cleanOptions.length > 0) {
        selectMenus.push(cleanOptions);
      }
      return ''; // Remove from content
    })
    .trim()
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/ +\n/g, '\n');

  logger.debug('Parsed interactive components', {
    buttonCount: buttons.length,
    selectMenuCount: selectMenus.length,
    buttons: buttons.map(b => b.id),
    selectOptions: selectMenus.map(m => m.length),
    hasInvalidXML: !validateXML(content),
  });

  return {
    content: cleanContent,
    components: { buttons, selectMenus },
  };
};

/**
 * Creates a properly formatted respond_to object with the new structure
 * This is the single source of truth for respond_to object creation
 *
 * CRITICAL: Must follow EXACTLY this format:
 * {
 *   channel: "discord",
 *   details: {
 *     type: "discord", // MUST match the channel value
 *     channelId: "CHANNEL_ID",
 *     threadId?: "THREAD_ID" // Only include if in a thread
 *     guildId?: "GUILD_ID" // Guild ID if available
 *     isDM?: boolean // Whether this is a DM channel
 *   },
 *   threadId?: "THREAD_ID" // Only include if in a thread (for Discord)
 * }
 *
 * DO NOT include any additional properties at the root level except threadId when needed.
 */
const createRespondToObject = (
  context,
  isThread,
  threadId,
  existingRespondTo = null
) => {
  const channel = 'discord';

  // Enhanced logging for input parameters
  logger.debug('Creating respond_to object', {
    hasContext: !!context,
    contextType: context ? typeof context : 'undefined',
    isThread,
    threadId,
    hasExistingRespondTo: !!existingRespondTo,
    existingRespondToType: existingRespondTo
      ? typeof existingRespondTo
      : 'undefined',
  });

  // Extract all necessary channel information
  const channelId = context.channelId || context.channel?.id;
  const guildId = context.guildId || context.guild?.id;
  const isDM = context.channel?.type === 'DM' || context.channel?.type === 1;

  // Create the details object with all required Discord properties
  const details = {
    type: channel,
    channelId,
  };

  // Add optional properties only if they exist
  if (threadId) {
    details.threadId = threadId;
  }

  if (guildId) {
    details.guildId = guildId;
  }

  if (isDM !== undefined) {
    details.isDM = isDM;
  }

  // Create the base respond_to object
  const respondTo = {
    channel,
    details,
  };

  // Only add threadId at the root level if it exists
  if (threadId) {
    respondTo.threadId = threadId;
  }

  // If we have an existing respond_to, merge its values but ONLY for the allowed properties
  if (existingRespondTo) {
    logger.debug('Merging with existing respond_to', {
      existingChannel: existingRespondTo.channel,
      existingType: existingRespondTo.details?.type,
      existingChannelId: existingRespondTo.details?.channelId,
      existingThreadId:
        existingRespondTo.details?.threadId || existingRespondTo.threadId,
    });

    if (existingRespondTo.channel === 'discord' && existingRespondTo.details) {
      if (existingRespondTo.details.channelId) {
        details.channelId = existingRespondTo.details.channelId;
      }

      if (existingRespondTo.details.threadId) {
        details.threadId = existingRespondTo.details.threadId;
        respondTo.threadId = existingRespondTo.details.threadId;
      }

      if (existingRespondTo.details.guildId) {
        details.guildId = existingRespondTo.details.guildId;
      }

      if (existingRespondTo.details.isDM !== undefined) {
        details.isDM = existingRespondTo.details.isDM;
      }

      if (existingRespondTo.threadId) {
        respondTo.threadId = existingRespondTo.threadId;
      }
    }
  }

  // Ensure the details object always has the correct type matching the channel
  details.type = respondTo.channel;

  // Final validation log
  logger.debug('Created respond_to object', {
    channel: respondTo.channel,
    detailsType: respondTo.details.type,
    channelId: respondTo.details.channelId,
    threadId: respondTo.details.threadId || 'none',
    guildId: respondTo.details.guildId || 'none',
    isDM: respondTo.details.isDM,
  });

  return respondTo;
};

// Simplified validateRespondTo function for Discord only
const validateRespondTo = (respondTo, context, isThread, threadId) => {
  if (!respondTo) {
    logger.debug('No respond_to object provided, creating new one');
    return createRespondToObject(context, isThread, threadId);
  }

  // Enhanced logging for validation
  logger.debug('Validating respond_to object', {
    hasChannel: !!respondTo.channel,
    channel: respondTo.channel,
    hasDetails: !!respondTo.details,
    detailsType: respondTo.details?.type,
    hasChannelId: !!respondTo.details?.channelId,
    hasThreadId: !!(respondTo.details?.threadId || respondTo.threadId),
  });

  const isSuspicious =
    respondTo.type === respondTo.channelId ||
    (!respondTo.type && !respondTo.channel);

  const hasInvalidProperties = Object.keys(respondTo).some(key => {
    return !['channel', 'details', 'threadId'].includes(key);
  });

  const hasMissingProperties =
    !respondTo.channel || !respondTo.details || !respondTo.details.type;

  const hasTypeMismatch =
    respondTo.details && respondTo.details.type !== respondTo.channel;

  const hasMissingChannelProperties =
    respondTo.channel === 'discord' && !respondTo.details?.channelId;

  if (
    isSuspicious ||
    hasInvalidProperties ||
    hasMissingProperties ||
    hasTypeMismatch ||
    hasMissingChannelProperties
  ) {
    logger.warn('Invalid respondTo object detected', {
      suspicious_pattern: isSuspicious
        ? `${
            respondTo.type === respondTo.channelId
              ? 'channelId same as type'
              : 'missing type/channel property'
          }`
        : null,
      has_invalid_properties: hasInvalidProperties
        ? `Found invalid properties for channel ${respondTo.channel}`
        : null,
      has_missing_properties: hasMissingProperties,
      has_type_mismatch: hasTypeMismatch
        ? `Type (${respondTo.details?.type}) doesn't match channel (${respondTo.channel})`
        : null,
      has_missing_channel_properties: hasMissingChannelProperties,
      original: JSON.stringify(respondTo),
    });
  }

  // Create a fixed respond_to object
  const fixedRespondTo = createRespondToObject(
    context,
    isThread,
    threadId,
    respondTo
  );

  // Log the differences between original and fixed
  if (JSON.stringify(respondTo) !== JSON.stringify(fixedRespondTo)) {
    logger.info('Fixed respond_to object', {
      original: JSON.stringify(respondTo),
      fixed: JSON.stringify(fixedRespondTo),
    });
  }

  return fixedRespondTo;
};

// Simplified validateFinalRespondTo function for Discord only
const validateFinalRespondTo = respondTo => {
  // Enhanced logging for final validation
  logger.debug('Final validation of respond_to object', {
    hasRespondTo: !!respondTo,
    channel: respondTo?.channel,
    hasDetails: !!respondTo?.details,
    detailsType: respondTo?.details?.type,
    hasChannelId: !!respondTo?.details?.channelId,
    hasThreadId: !!(respondTo?.details?.threadId || respondTo?.threadId),
  });

  if (!respondTo) {
    logger.error('Missing respond_to object in final validation');
    return false;
  }

  if (respondTo.channel !== 'discord') {
    logger.error('Invalid channel in respond_to object', {
      channel: respondTo.channel,
    });
    return false;
  }

  if (!respondTo.details) {
    logger.error('Missing details in respond_to object');
    return false;
  }

  if (respondTo.details.type !== respondTo.channel) {
    logger.error('Type in details does not match channel value', {
      channel: respondTo.channel,
      type: respondTo.details.type,
    });
    return false;
  }

  if (!respondTo.details.channelId) {
    logger.error('Missing channelId in respond_to.details for discord channel');
    return false;
  }

  const invalidDetailsProps = Object.keys(respondTo.details).filter(
    key => !['type', 'channelId', 'threadId', 'guildId', 'isDM'].includes(key)
  );

  if (invalidDetailsProps.length > 0) {
    logger.error('Invalid properties in respond_to.details for discord', {
      invalidProps: invalidDetailsProps,
    });
    return false;
  }

  if (
    respondTo.threadId &&
    respondTo.details.threadId &&
    respondTo.threadId !== respondTo.details.threadId
  ) {
    logger.error('Inconsistent threadId values in respond_to', {
      rootThreadId: respondTo.threadId,
      detailsThreadId: respondTo.details.threadId,
    });
    return false;
  }

  const validRootProps = ['channel', 'details', 'threadId'];
  const invalidRootProps = Object.keys(respondTo).filter(
    key => !validRootProps.includes(key)
  );

  if (invalidRootProps.length > 0) {
    logger.error('Invalid properties at root level of respond_to', {
      invalidProps: invalidRootProps,
    });
    return false;
  }

  logger.debug('respond_to object passed final validation', {
    channel: respondTo.channel,
    channelId: respondTo.details.channelId,
    threadId: respondTo.details.threadId || respondTo.threadId || 'none',
    guildId: respondTo.details.guildId || 'none',
    isDM: respondTo.details.isDM,
  });

  return true;
};

export const capabilitiesClient = {
  chat: async (message, context, retryCount = 0) => {
    const isInteraction = 'customId' in context;
    const userId = isInteraction
      ? context.user.username
      : context.author.username;

    try {
      // Normalize the capabilities URL
      const normalizeUrl = url => {
        // Remove any existing http:// or https://
        const cleanUrl = url.replace(/^(https?:\/\/)/, '');
        // Add http:// prefix
        return `http://${cleanUrl}`;
      };

      const rawUrl = process.env.CAPABILITIES_URL || '';
      const normalizedUrl = normalizeUrl(rawUrl);
      const constructedUrl = `${normalizedUrl}/chat`;

      // Detailed URL construction logging
      console.log('[CAPS DEBUG] URL Construction:', {
        timestamp: new Date().toISOString(),
        raw_capabilities_url: process.env.CAPABILITIES_URL,
        normalized_url: normalizedUrl,
        constructed_url: constructedUrl,
        raw_express_port: process.env.EXPRESS_PORT,
        raw_port: process.env.PORT,
        pwd: process.cwd(),
        env_path: process.env.PWD,
        node_env: process.env.NODE_ENV,
      });

      // Determine if this is a DM channel
      const isDM = isInteraction
        ? context.channel?.type === 1 // DM channel type in interactions
        : context.channel?.type === 'DM' || context.channel?.type === 1;

      // Determine if this is a thread - MOVED UP before it's used in the body_preview
      const isThread = !!context.channel?.isThread?.();
      const threadId = isThread ? context.channel?.id : null;
      const parentId = isThread ? context.channel?.parentId : null;

      // Get recipient info for DMs
      const dmRecipient = isDM
        ? {
            recipientId: isInteraction
              ? context.user.id
              : context.channel?.recipient?.id || context.author.id,
            recipientUsername: isInteraction
              ? context.user.username
              : context.channel?.recipient?.username || context.author.username,
          }
        : null;

      logger.debug('Sending request to capabilities service', {
        userId,
        messageLength: message.length,
        isInteraction,
      });

      // Create respond_to object ONCE at the beginning - the single source of truth
      const initialRespondTo = createRespondToObject(
        context,
        isThread,
        threadId
      );

      logger.debug('Initial respond_to object created', {
        channel: initialRespondTo.channel,
        channelId: initialRespondTo.details.channelId,
        threadId: initialRespondTo.threadId || 'none',
      });

      // Add pre-request debug logging
      console.log('[CAPS DEBUG] Making capabilities request:', {
        raw_url: process.env.CAPABILITIES_URL,
        normalized_url: normalizedUrl,
        constructed_url: constructedUrl,
        parsed_url: new URL(constructedUrl),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer [REDACTED]',
        },
        body_preview: {
          messageLength: message?.length,
          userId,
          hasCapabilities: true,
          channelInfo: {
            channelType: 'discord',
            channelId: context.channelId || context.channel?.id,
            isDM: isInteraction
              ? context.channel?.type === 1
              : context.channel?.type === 'DM' || context.channel?.type === 1,
          },
          respond_to: initialRespondTo, // Use our initial respond_to object
        },
      });

      // Extract high-value Discord metadata
      const messageTimestamp = isInteraction
        ? context.createdTimestamp
        : context.createdTimestamp || context.createdAt?.getTime();

      const guildInfo = context.guild
        ? {
            guildId: context.guild.id,
            guildName: context.guild.name,
            memberCount: context.guild.memberCount,
            isVerified: context.guild.verified || false,
          }
        : null;

      const channelName = context.channel?.name || null;

      const userRoles =
        !isDM && context.member?.roles?.cache
          ? Array.from(context.member.roles.cache.values())
              .map(role => ({ id: role.id, name: role.name }))
              .filter(role => role.name !== '@everyone')
          : [];

      // Get user account information
      const userAccount = {
        id: isInteraction ? context.user.id : context.author.id,
        username: isInteraction
          ? context.user.username
          : context.author.username,
        discriminator: isInteraction
          ? context.user.discriminator
          : context.author.discriminator,
        bot: isInteraction ? context.user.bot : context.author.bot,
        system: isInteraction ? context.user.system : context.author.system,
        createdTimestamp: isInteraction
          ? context.user.createdTimestamp
          : context.author.createdTimestamp,
        // Calculate account age in days
        accountAge: isInteraction
          ? Math.floor(
              (Date.now() - context.user.createdTimestamp) /
                (1000 * 60 * 60 * 24)
            )
          : Math.floor(
              (Date.now() - context.author.createdTimestamp) /
                (1000 * 60 * 60 * 24)
            ),
      };

      // Get guild member information if available
      const memberInfo = context.member
        ? {
            nickname: context.member.nickname,
            joinedTimestamp: context.member.joinedTimestamp,
            // How long they've been in this server in days
            memberAge: Math.floor(
              (Date.now() - context.member.joinedTimestamp) /
                (1000 * 60 * 60 * 24)
            ),
            premiumSince: context.member.premiumSince,
            isOwner: context.guild?.ownerId === userAccount.id,
          }
        : null;

      // Log channel context for debugging
      console.log('[CAPS DEBUG] Channel context:', {
        isDM,
        isInteraction,
        channelType: isInteraction
          ? context.channel?.type
          : context.channel?.type,
        channelId: context.channelId || context.channel?.id,
        isThread,
        threadId,
        parentId,
        guildId: context.guildId || context.guild?.id,
        dmRecipient: dmRecipient,
        authorInfo: isInteraction
          ? { id: context.user?.id, username: context.user?.username }
          : { id: context.author?.id, username: context.author?.username },
        messageTimestamp,
        guildInfo,
        channelName,
        userRoles,
        userAccount,
        memberInfo,
      });

      const response = await fetch(constructedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WEBHOOK_SECRET}`,
        },
        body: JSON.stringify({
          message,
          userId,
          userContext: {
            discordId: isInteraction ? context.user.id : context.author.id,
            username: isInteraction
              ? context.user.username
              : context.author.username,
            tag: isInteraction ? context.user.tag : context.author.tag,
            environment: process.env.LOKI_ENVIRONMENT,
            roles: userRoles,
            messageTimestamp,
            accountAge: userAccount.accountAge,
            isNewAccount: userAccount.accountAge < 30, // Flag accounts less than a month old
            ...(memberInfo && {
              memberSince: memberInfo.joinedTimestamp,
              isServerOwner: memberInfo.isOwner,
            }),
          },
          channelInfo: {
            channelType: 'discord',
            channelId: context.channelId || context.channel?.id,
            channelName,
            threadId,
            parentId,
            isThread,
            guildId: context.guildId || context.guild?.id,
            isDM,
            ...(isDM && { dmRecipient }),
            ...(guildInfo && { guildInfo }),
          },
          capabilities: {
            interactiveElements: INTERACTIVE_CAPABILITIES,
          },
          respond_to: initialRespondTo, // Use our initial respond_to object
          metadata: {
            clientTimestamp: Date.now(),
            messageTimestamp,
            messageLength: message?.length,
            isInteraction,
            interactionType: isInteraction ? context.componentType : null,
            hasAttachments: !isInteraction && context.attachments?.size > 0,
            isReply: !isInteraction && !!context.reference,
            isFirstTimeUser: memberInfo?.memberAge < 1, // First day in server
          },
        }),
      });

      // Add post-request debug logging
      console.log('[CAPS DEBUG] Got response:', {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
      });

      // Check the content type to determine how to process the response
      const contentType = response.headers.get('content-type') || '';
      let data = {};
      let content = '';

      if (contentType.includes('application/json')) {
        // Process as JSON response
        data = await response.json();
        logger.debug('Received JSON response from capabilities service', {
          responseLength: data.response?.length,
          hasComponents: !!data.components,
          rawResponse: data.response?.substring(0, 200) + '...', // Log first 200 chars
        });
        content = data.response || data.message || '';
      } else {
        // Process as text/HTML response
        content = await response.text();
        logger.debug('Received text response from capabilities service', {
          responseLength: content.length,
          contentType: contentType,
          rawResponse: content.substring(0, 200) + '...', // Log first 200 chars
        });

        // Create a synthetic data object for text responses
        data = {
          response: content,
          respond_to: initialRespondTo, // Use our initial object for text responses
        };
      }

      // Always use our initial respond_to unless the service provides a valid one
      if (!data.respond_to || !validateFinalRespondTo(data.respond_to)) {
        data.respond_to = initialRespondTo;
        logger.info('Using initial respond_to object', {
          object: JSON.stringify(initialRespondTo),
        });
      }

      const { content: cleanContent, components } =
        parseInteractiveComponents(content);

      // Final validation check for capabilities
      if (data.capabilities && data.capabilities.length > 0) {
        logger.info('Capabilities detected in response', {
          count: data.capabilities.length,
          types: data.capabilities.map(cap => cap.type),
        });

        // Ensure each capability has the correct channel type - use initialRespondTo if invalid
        data.capabilities.forEach((capability, index) => {
          logger.debug(
            `Processing capability ${index + 1}/${data.capabilities.length}`,
            {
              type: capability.type,
              hasRespondTo: !!capability.respond_to,
            }
          );

          if (
            !capability.respond_to ||
            !validateFinalRespondTo(capability.respond_to)
          ) {
            capability.respond_to = initialRespondTo;
            logger.info(
              `Using initial respond_to for capability ${capability.type}`,
              {
                capability_type: capability.type,
              }
            );
          }
        });
      }

      // No need for final validation - we're using our initial object if service doesn't provide valid one

      return {
        content: cleanContent?.substring(0, 2000), // Enforce Discord limit
        components: components || {},
        capabilities: data.capabilities || [], // Pass capabilities back to client
      };
    } catch (error) {
      // Enhanced error logging for capabilities
      logger.error('Capabilities service error', {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
        context: {
          userId,
          isInteraction,
          messageLength: message?.length,
          channelInfo: {
            channelId: context.channelId || context.channel?.id,
            isDM: context.channel?.type === 'DM' || context.channel?.type === 1,
          },
          retryCount,
        },
      });

      // Retry logic for transient errors
      if (
        retryCount < 2 &&
        (error.message.includes('ECONNREFUSED') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('socket hang up') ||
          error.message.includes('network timeout'))
      ) {
        logger.info('Retrying capabilities request after error', {
          error: error.message,
          retryCount: retryCount + 1,
        });

        // Exponential backoff
        const backoffMs = Math.pow(2, retryCount) * 500;
        await new Promise(resolve => setTimeout(resolve, backoffMs));

        return capabilitiesClient.chat(message, context, retryCount + 1);
      }

      throw new CapabilitiesError(
        `Failed to process message: ${error.message}`,
        error.status || 500,
        {
          errorText:
            'There was a problem connecting to my capabilities service.',
          originalError: error,
        }
      );
    }
  },
};

// Helper function to identify changes between two respond_to objects
function identifyChanges(original, updated) {
  const changes = [];

  if (!original || !updated) {
    return ['Complete object replacement'];
  }

  if (original.channel !== updated.channel) {
    changes.push(`channel: ${original.channel} -> ${updated.channel}`);
  }

  // Compare details objects
  if (!original.details && updated.details) {
    changes.push('Added details object');
  } else if (original.details && updated.details) {
    if (original.details.type !== updated.details.type) {
      changes.push(
        `details.type: ${original.details.type} -> ${updated.details.type}`
      );
    }

    if (original.details.channelId !== updated.details.channelId) {
      changes.push(
        `details.channelId: ${original.details.channelId} -> ${updated.details.channelId}`
      );
    }

    if (original.details.threadId !== updated.details.threadId) {
      changes.push(
        `details.threadId: ${original.details.threadId || 'none'} -> ${
          updated.details.threadId || 'none'
        }`
      );
    }

    if (original.details.guildId !== updated.details.guildId) {
      changes.push(
        `details.guildId: ${original.details.guildId || 'none'} -> ${
          updated.details.guildId || 'none'
        }`
      );
    }

    if (original.details.isDM !== updated.details.isDM) {
      changes.push(
        `details.isDM: ${original.details.isDM} -> ${updated.details.isDM}`
      );
    }
  }

  // Check threadId at root level
  if (original.threadId !== updated.threadId) {
    changes.push(
      `threadId: ${original.threadId || 'none'} -> ${
        updated.threadId || 'none'
      }`
    );
  }

  return changes.length > 0 ? changes : ['No significant changes'];
}

// Helper function to get detailed validation errors for a respond_to object
function getValidationErrors(respondTo) {
  const errors = [];

  if (!respondTo) {
    return ['respond_to object is null or undefined'];
  }

  if (respondTo.channel !== 'discord') {
    errors.push(`Invalid channel: ${respondTo.channel} (expected 'discord')`);
  }

  if (!respondTo.details) {
    errors.push('Missing details object');
  } else {
    if (!respondTo.details.type) {
      errors.push('Missing type in details');
    } else if (respondTo.details.type !== respondTo.channel) {
      errors.push(
        `Type mismatch: details.type (${respondTo.details.type}) doesn't match channel (${respondTo.channel})`
      );
    }

    if (!respondTo.details.channelId) {
      errors.push('Missing channelId in details');
    }

    // Check for invalid properties in details
    const invalidDetailsProps = Object.keys(respondTo.details).filter(
      key => !['type', 'channelId', 'threadId', 'guildId', 'isDM'].includes(key)
    );

    if (invalidDetailsProps.length > 0) {
      errors.push(
        `Invalid properties in details: ${invalidDetailsProps.join(', ')}`
      );
    }
  }

  // Check for threadId consistency
  if (
    respondTo.threadId &&
    respondTo.details?.threadId &&
    respondTo.threadId !== respondTo.details.threadId
  ) {
    errors.push(
      `Inconsistent threadId values: root (${respondTo.threadId}) vs details (${respondTo.details.threadId})`
    );
  }

  // Check for invalid root properties
  const validRootProps = ['channel', 'details', 'threadId'];
  const invalidRootProps = Object.keys(respondTo).filter(
    key => !validRootProps.includes(key)
  );

  if (invalidRootProps.length > 0) {
    errors.push(
      `Invalid properties at root level: ${invalidRootProps.join(', ')}`
    );
  }

  return errors.length > 0
    ? errors
    : ['No specific validation errors found, but validation failed'];
}

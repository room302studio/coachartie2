import { Client, GatewayIntentBits, ChannelType, Partials } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { DB_TABLES } from './config/database.js';
// Import Database type for TypeScript support in JSDoc comments
// @ts-check
import { DiscordError, CapabilitiesError } from './types/errors.js';
import { checkEnvVars } from './utils/envCheck.js';
import { logger } from './utils/logger.js';
import { capabilitiesClient } from './services/capabilities.js';
import { createButtonRow, createSelectMenu } from './features/interactions.js';
import { PresenceManager } from './features/presence.js';

// Set up __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log process startup details
process.on('beforeExit', code => {
  logger.warn('Process beforeExit', { code, memory: process.memoryUsage() });
});

process.on('exit', code => {
  logger.warn('Process exit', { code, memory: process.memoryUsage() });
});

// Log any warnings from Node.js
process.on('warning', warning => {
  logger.warn('Node.js warning', {
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
    detail: warning.detail,
  });
});

// Monitor event loop
setInterval(() => {
  logger.debug('System health check', {
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptime: Math.round(process.uptime()),
    bot_state: {
      is_ready: bot?.bot?.isReady(),
      guilds: bot?.bot?.guilds?.cache?.size,
    },
  });
}, 300000); // Every 5 minutes

logger.info('Starting application', {
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  ppid: process.ppid,
  memory_usage: process.memoryUsage(),
  cpu_usage: process.cpuUsage(),
  resource_usage: process.resourceUsage(),
  cwd: process.cwd(),
  argv: process.argv,
  execPath: process.execPath,
  env: {
    NODE_ENV: process.env.NODE_ENV,
    PWD: process.env.PWD,
    PATH: process.env.PATH,
  },
});

// Load environment variables with explicit path
const envPath = path.resolve(__dirname, '.env');
logger.info('Loading environment variables', {
  path: envPath,
  exists: fs.existsSync(envPath),
  dirname: __dirname,
  absolute_path: path.resolve(envPath),
  current_capabilities_url: process.env.CAPABILITIES_URL,
  current_express_port: process.env.EXPRESS_PORT,
  current_port: process.env.PORT,
});

const envResult = dotenv.config({ path: envPath });
if (envResult.error) {
  logger.error('Failed to load .env file', {
    error: envResult.error,
    path: envPath,
  });
  process.exit(1);
}

logger.info('Environment variables loaded', {
  count: Object.keys(envResult.parsed || {}).length,
  keys: Object.keys(envResult.parsed || {}).map(k =>
    k.replace(/key|token|secret/gi, '[REDACTED]')
  ),
  capabilities_url: process.env.CAPABILITIES_URL,
  express_port: process.env.EXPRESS_PORT,
  port: process.env.PORT,
  env_path: process.env.PWD,
  node_env: process.env.NODE_ENV,
});

// Validate environment variables
try {
  checkEnvVars();
  logger.info('Environment variables validated successfully');
} catch (error) {
  logger.error('Environment validation failed', {
    error,
    available_env_vars: Object.keys(process.env).filter(
      k =>
        !k.toLowerCase().includes('key') &&
        !k.toLowerCase().includes('token') &&
        !k.toLowerCase().includes('secret')
    ),
  });
  process.exit(1);
}

// Global error handlers
let bot; // Reference to bot instance for cleanup
let shutdownInProgress = false;

const handleGracefulShutdown = async (signal, error = null) => {
  if (shutdownInProgress) {
    logger.warn('Shutdown already in progress, received another signal', {
      signal,
    });
    return;
  }

  shutdownInProgress = true;
  logger.info('Initiating graceful shutdown', {
    signal,
    error: error
      ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        }
      : null,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    resources: process.resourceUsage(),
    bot_state: {
      is_ready: bot?.bot?.isReady(),
      message_count: bot?.messageCount,
      error_count: bot?.errorCount,
      unique_users: bot?.uniqueUsers?.size,
      guilds: bot?.bot?.guilds?.cache?.size,
    },
  });

  try {
    if (bot?.bot?.isReady()) {
      logger.info('Destroying Discord client...', {
        guilds: bot.bot.guilds.cache.size,
        users: bot.bot.users.cache.size,
      });
      await bot.bot.destroy();
      logger.info('Discord client destroyed successfully');
    }

    // Close any other connections
    if (bot?.supabase) {
      logger.info('Closing Supabase connection...');
      // Note: Supabase client doesn't have a close method, but logging for completeness
    }

    logger.info('Shutdown complete', {
      final_memory: process.memoryUsage(),
      final_cpu: process.cpuUsage(),
    });
  } catch (shutdownError) {
    logger.error('Error during shutdown', {
      original_error: error,
      shutdown_error: shutdownError,
      memory: process.memoryUsage(),
    });
  } finally {
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    error: reason,
    promise_details: {
      state: promise.state,
      stack: reason?.stack,
    },
    memory_usage: process.memoryUsage(),
    uptime: process.uptime(),
    bot_state: {
      is_ready: bot?.bot?.isReady(),
      message_count: bot?.messageCount,
      error_count: bot?.errorCount,
    },
  });
  handleGracefulShutdown('unhandledRejection', reason);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught Exception', {
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack,
      code: error.code,
    },
    memory_usage: process.memoryUsage(),
    uptime: process.uptime(),
    bot_state: {
      is_ready: bot?.bot?.isReady(),
      message_count: bot?.messageCount,
      error_count: bot?.errorCount,
    },
  });
  handleGracefulShutdown('uncaughtException', error);
});

// Handle graceful shutdown on SIGTERM and SIGINT
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

export class DiscordBot {
  constructor() {
    try {
      logger.info('Initializing Discord bot', {
        startTime: Date.now(),
        node_env: process.env.NODE_ENV,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        process: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
      });

      this.startTime = Date.now();
      this.messageCount = 0;
      this.errorCount = 0;
      this.uniqueUsers = new Set();
      this.loginAttempts = 0;
      this.lastReconnectTime = null;
      this.disconnectCount = 0;
      this.capabilitiesVersion = null; // Track capabilities version

      // Initialize Discord client with required intents
      logger.info('Creating Discord client with intents', {
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageTyping,
          GatewayIntentBits.DirectMessageReactions,
        ],
        client_options: {
          failIfNotExists: false,
          retryLimit: 3,
        },
      });

      this.bot = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.GuildMessageTyping,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
          GatewayIntentBits.DirectMessageTyping,
        ],
        partials: [
          Partials.Channel,
          Partials.Message,
          Partials.User,
          Partials.GuildMember,
          Partials.Reaction,
        ],
        failIfNotExists: false,
        retryLimit: 3,
      });

      this.presence = new PresenceManager(this.bot);

      // Set up event handlers first
      logger.info('Setting up event handlers...');
      this.setupEventHandlers();

      // Then attempt login
      logger.info('Initiating Discord login...');
      this.login();
    } catch (error) {
      logger.error('Critical initialization error', {
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
          type: error.constructor.name,
        },
        context: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
          state: {
            message_count: this.messageCount,
            error_count: this.errorCount,
            unique_users: this.uniqueUsers?.size,
            login_attempts: this.loginAttempts,
            disconnect_count: this.disconnectCount,
          },
        },
      });
      throw error;
    }
  }

  setupEventHandlers() {
    // Connection state events
    this.bot.on('disconnect', event => {
      this.disconnectCount++;
      logger.warn('Discord client disconnected', {
        event,
        metrics: {
          disconnect_count: this.disconnectCount,
          uptime: process.uptime(),
        },
      });
    });

    // Add specific DM handler
    this.bot.on('directMessage', message => {
      logger.debug('Direct message received', {
        content: message.content,
        author: message.author.username,
      });
    });

    this.bot.on('reconnecting', () => {
      this.lastReconnectTime = Date.now();
      logger.warn('Discord client reconnecting', {
        metrics: {
          disconnect_count: this.disconnectCount,
          uptime: process.uptime(),
        },
      });
    });

    this.bot.on('resume', replayed => {
      logger.info('Discord client resumed', {
        replayed_events: replayed,
        reconnect_time: this.lastReconnectTime
          ? Date.now() - this.lastReconnectTime
          : null,
        metrics: {
          disconnect_count: this.disconnectCount,
          uptime: process.uptime(),
        },
      });
    });

    // Rate limit events
    this.bot.on('rateLimit', rateLimitInfo => {
      logger.warn('Discord rate limit hit', {
        ...rateLimitInfo,
        metrics: {
          uptime: process.uptime(),
        },
      });
    });

    // Error handling for the Discord client
    this.bot.on('error', error => {
      this.errorCount++;
      logger.error('Discord client error', {
        error: error.message,
        metrics: {
          total_errors: this.errorCount,
        },
      });
    });

    this.bot.on('debug', info => {
      // Filter out heartbeat messages
      if (info.includes('Heartbeat') || info.includes('heartbeat')) {
        return;
      }

      logger.debug('Discord debug info', {
        info,
        state: {
          is_ready: this.bot.isReady(),
          login_attempts: this.loginAttempts,
        },
      });
    });

    this.bot.on('warn', warning => {
      logger.warn('Discord warning', {
        warning,
        state: {
          is_ready: this.bot.isReady(),
          login_attempts: this.loginAttempts,
          disconnect_count: this.disconnectCount,
        },
      });
    });

    this.bot.on('ready', async () => {
      const tag = this.bot.user.tag;
      const guilds = this.bot.guilds.cache;
      const channels = this.bot.channels.cache;
      const users = this.bot.users.cache;

      // Set version in status
      this.bot.user.setActivity(
        `v${process.env.npm_package_version || '1.0.4'}`,
        { type: 'PLAYING' }
      );

      // Wait for application to be ready and retry a few times if needed
      let retries = 0;
      while (!this.bot.application?.id && retries < 5) {
        logger.info('Waiting for application to be ready...', { retries });
        await new Promise(resolve => setTimeout(resolve, 1000));
        retries++;
      }

      if (!this.bot.application?.id) {
        logger.error('Application ID not available after waiting');
        return;
      }

      // Register slash commands
      try {
        const commands = [
          {
            name: 'health',
            description:
              'Get detailed health information about the bot and capabilities server',
          },
          {
            name: 'help',
            description:
              'Learn about what I can do and how to use me effectively',
            options: [
              {
                name: 'topic',
                type: 3,
                description: 'Specific topic to get help with',
                required: false,
                choices: [
                  { name: '🤖 General Usage', value: 'general' },
                  { name: '💬 Chat Features', value: 'chat' },
                  { name: '🎮 Interactive Features', value: 'interactive' },
                  { name: '📊 Stats & Health', value: 'stats' },
                  { name: '⚙️ Technical Details', value: 'technical' },
                ],
              },
            ],
          },
          {
            name: 'memories',
            description:
              'View your recent interactions and memories with Coach Artie',
          },
          {
            name: 'search',
            description: 'Search through your memories with Coach Artie',
            options: [
              {
                name: 'text',
                type: 3, // STRING
                description: 'What would you like to search for?',
                required: true,
              },
            ],
          },
          {
            name: 'vector',
            description:
              'Find semantically similar memories (AI-powered search)',
            options: [
              {
                name: 'text',
                type: 3, // STRING
                description: "Describe what you're looking for",
                required: true,
              },
            ],
          },
          {
            name: 'stats',
            description: 'View your personal stats and profile summary',
          },
        ];

        logger.info('Attempting to register commands globally', {
          application_id: this.bot.application.id,
          commands: commands.map(c => c.name),
        });

        const registeredCommands = await this.bot.application.commands.set(
          commands
        );

        logger.info('Successfully registered global commands', {
          registered_count: registeredCommands.size,
          commands: registeredCommands.map(cmd => ({
            name: cmd.name,
            id: cmd.id,
          })),
        });
      } catch (error) {
        logger.error('Failed to register global commands', {
          error: error.message,
          stack: error.stack,
        });

        // Fallback to guild-specific registration
        for (const [guildId, guild] of guilds) {
          try {
            const guildCommands = await guild.commands.set(commands);
            logger.info('Registered commands for guild', {
              guildId,
              guildName: guild.name,
              commands: guildCommands.map(cmd => cmd.name),
            });
          } catch (guildError) {
            logger.error('Failed to register commands for guild', {
              guildId,
              guildName: guild.name,
              error: guildError.message,
            });
          }
        }
      }

      logger.info('Discord bot ready', {
        bot: {
          tag,
          id: this.bot.user.id,
          verified: this.bot.user.verified,
          createdTimestamp: this.bot.user.createdTimestamp,
          application_id: this.bot.application?.id,
        },
        metrics: {
          guildCount: guilds.size,
          totalMembers: guilds.reduce(
            (acc, guild) => acc + guild.memberCount,
            0
          ),
          channelCount: channels.size,
          userCount: users.size,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          login_attempts: this.loginAttempts,
          disconnect_count: this.disconnectCount,
        },
      });
    });

    this.bot.on('messageCreate', async message => {
      // Add detailed logging for every message
      logger.debug('Received message event', {
        channel_type: message.channel.type,
        channel_id: message.channel.id,
        is_dm: message.channel.type === ChannelType.DM,
        is_bot: message.author.bot,
        has_mention: message.mentions.has(this.bot.user),
        content_length: message.content.length,
        author: message.author.username,
        content: message.content, // Add this for debugging
      });

      // Check if we should respond
      const shouldHandle = this.shouldRespond(message);
      logger.debug('Message handling decision', {
        should_handle: shouldHandle,
        message_id: message.id,
        channel_type: message.channel.type,
        is_dm: message.channel.type === ChannelType.DM,
      });

      if (shouldHandle) {
        await this.handleMessage(message);
      }
    });

    // Log guild-related events
    this.bot.on('guildCreate', guild => {
      logger.info('Bot added to new guild', {
        guild: {
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
          channelCount: guild.channels.cache.size,
        },
      });
    });

    this.bot.on('guildDelete', guild => {
      logger.warn('Bot removed from guild', {
        guild: {
          id: guild.id,
          name: guild.name,
        },
      });
    });

    // Make sure we're listening for interactions
    this.bot.on('interactionCreate', interaction => {
      if (interaction.isChatInputCommand()) {
        this._handleSlashCommand(interaction);
      } else {
        this._handleInteraction(interaction);
      }
    });
  }

  async login() {
    this.loginAttempts++;
    try {
      logger.info('Attempting Discord bot login', {
        attempt: this.loginAttempts,
        token_length: process.env.DISCORD_BOT_TOKEN?.length,
        token_prefix: process.env.DISCORD_BOT_TOKEN?.substring(0, 10) + '...',
      });

      if (!process.env.DISCORD_BOT_TOKEN) {
        throw new Error('DISCORD_BOT_TOKEN is not set');
      }

      // Add event listener for the initial connection attempt
      this.bot.once('shardError', error => {
        logger.error('Shard error during login', {
          error: {
            message: error.message,
            stack: error.stack,
            code: error.code,
          },
          attempt: this.loginAttempts,
        });
      });

      this.bot.once('shardReady', shardId => {
        logger.info('Shard ready', { shardId });
      });

      await this.bot.login(process.env.DISCORD_BOT_TOKEN);

      logger.info('Discord login successful', {
        metrics: {
          login_attempts: this.loginAttempts,
          disconnect_count: this.disconnectCount,
          uptime: process.uptime(),
        },
        bot: {
          user: this.bot.user?.tag,
          id: this.bot.user?.id,
          application_id: this.bot.application?.id,
        },
      });
    } catch (error) {
      this.errorCount++;
      logger.error('Discord login failed', {
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
          type: error.constructor.name,
        },
        metrics: {
          total_errors: this.errorCount,
          login_attempts: this.loginAttempts,
          disconnect_count: this.disconnectCount,
        },
        context: {
          token_length: process.env.DISCORD_BOT_TOKEN?.length,
          token_prefix: process.env.DISCORD_BOT_TOKEN?.substring(0, 10) + '...',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      });

      // If we've tried too many times, exit the process
      if (this.loginAttempts >= 3) {
        logger.error('Maximum login attempts reached, exiting...', {
          total_attempts: this.loginAttempts,
        });
        process.exit(1);
      }

      // Wait before retrying
      const retryDelay = Math.min(
        1000 * Math.pow(2, this.loginAttempts),
        30000
      );
      logger.info('Waiting before retry', {
        delay_ms: retryDelay,
        attempt: this.loginAttempts,
      });

      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return this.login(); // Retry login
    }
  }

  getSupabase() {
    if (!this.supabase) {
      logger.debug('Initializing Supabase client', {
        url: process.env.SUPABASE_URL,
        key_length: process.env.SUPABASE_API_KEY?.length,
      });

      try {
        this.supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_API_KEY
        );
        logger.info('Supabase client initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize Supabase client', {
          error: {
            message: error.message,
            stack: error.stack,
          },
        });
        throw error;
      }
    }
    return this.supabase;
  }

  // Split long messages into chunks of 1800 characters
  splitMessage(text) {
    const maxLength = 1800;
    const chunks = [];

    while (text.length > 0) {
      let chunk = text.substring(0, maxLength);

      // If we're in the middle of a word and there's more text, find the last space
      if (text.length > maxLength && chunk.lastIndexOf(' ') > 0) {
        chunk = chunk.substring(0, chunk.lastIndexOf(' '));
      }

      chunks.push(chunk);
      text = text.substring(chunk.length).trim();
    }

    return chunks;
  }

  async handleMessage(message) {
    if (!this.shouldRespond(message)) return;

    this.messageCount++;
    this.uniqueUsers.add(message.author.id);

    try {
      // Only handle reactions in non-DM channels
      const isDM = message.channel.type === ChannelType.DM;
      if (!isDM) {
        await message.react('🤔');
      }

      // Enhanced version check handler
      if (
        message.content
          .toLowerCase()
          .includes('what discord bot version is running?')
      ) {
        const version = process.env.npm_package_version || '1.0.4';
        const capabilities = await this.checkCapabilitiesVersion();

        const statusEmoji =
          capabilities.status === 'healthy'
            ? '🟢'
            : capabilities.status === 'degraded'
            ? '🟡'
            : '🔴';

        const response = [
          `🤖 Discord Bot Version: ${version}`,
          `⚡ Capabilities Version: ${capabilities.version}`,
          `${statusEmoji} Capabilities Status: ${
            capabilities.status || 'unknown'
          }`,
        ].join('\n');

        await message.reply(response);
        return true;
      }

      await this.processMessage(message);
      this.presence.incrementStat('messagesProcessed', message.author.id);

      // Only remove reactions in non-DM channels
      if (!isDM) {
        await message.reactions.removeAll();
      }
    } catch (error) {
      logger.error('Message processing failed', {
        error: error.message,
        message_id: message.id,
      });

      try {
        // Only try to remove reactions in non-DM channels
        if (message.channel.type !== ChannelType.DM) {
          await message.reactions.removeAll();
        }
        await message.reply(error.message);
      } catch (replyError) {
        logger.error('Failed to send error message', { error: replyError });
      }
    }
  }

  async processMessage(message) {
    const taskStartTime = Date.now();
    const queueTime = Date.now() - message.createdTimestamp;
    const isDM = message.channel.type === ChannelType.DM;

    logger.debug('Starting message processing', {
      message_id: message.id,
      queue_time_ms: queueTime,
      content_length: message.content.length,
      is_dm: isDM,
    });

    // Start typing indicator loop for DMs
    let typingInterval;
    if (isDM) {
      typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(error => {
          logger.warn('Failed to send typing indicator', {
            error: error.message,
            channel_id: message.channel.id,
          });
        });
      }, 5000); // Refresh typing indicator every 5 seconds
    }

    try {
      // Send request to capabilities service using updated client
      logger.debug('Sending request to capabilities service', {
        message_id: message.id,
      });

      const result = await capabilitiesClient.chat(message.content, message);

      // Clear typing indicator interval if it exists
      if (typingInterval) {
        clearInterval(typingInterval);
      }

      logger.info('Message processed', {
        message_id: message.id,
        processing_time_ms: Date.now() - taskStartTime,
        success: result.success,
        metadata: result.metadata,
      });

      // Clean up excessive newlines in the content
      if (result.content) {
        result.content = result.content
          .replace(/\n{3,}/g, '\n\n') // Replace 3+ newlines with 2
          .trim();
      }

      // If we have interactive components, create and send them
      if (
        result.components?.buttons?.length ||
        result.components?.selectMenus?.length
      ) {
        const rows = [];

        // Create button row if we have buttons
        if (result.components.buttons?.length) {
          rows.push(createButtonRow(result.components.buttons));
        }

        // Create select menu rows
        if (result.components.selectMenus?.length) {
          result.components.selectMenus.forEach(options => {
            rows.push({ type: 1, components: [createSelectMenu(options)] });
          });
        }

        // Send message with components
        if (result.content) {
          // Split long messages
          const chunks = this.splitMessage(result.content);

          // Send each chunk
          for (const chunk of chunks) {
            if (result.components && chunks.length === 1) {
              // Only add components to single messages or last chunk
              await message.reply({
                content: chunk,
                components: rows,
              });
            } else {
              await message.reply(chunk);
            }
          }
        }
      } else {
        // Send regular message without components
        const chunks = this.splitMessage(result.content);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }

      if (result.components?.reactions?.length) {
        for (const emoji of result.components.reactions) {
          try {
            await message.react(emoji);
            // Update the bot's mood based on the reaction
            this.presence.setMood(emoji);
            logger.debug('Added reaction', { emoji, messageId: message.id });
          } catch (error) {
            logger.warn('Failed to add reaction', {
              emoji,
              messageId: message.id,
              error: error.message,
            });
          }
        }
      }

      return true;
    } catch (error) {
      // Clear typing indicator interval if it exists
      if (typingInterval) {
        clearInterval(typingInterval);
      }

      this.errorCount++;
      logger.error('Failed to process message with capabilities service', {
        error: {
          message: error.message,
          details: error.details,
          stack: error.stack,
          name: error.name,
          code: error.code,
        },
        context: {
          capabilities_url: process.env.CAPABILITIES_URL,
        },
      });

      // More specific error messages based on the error type
      let userMessage = '❌ ';
      if (error.message.includes('BASE_TYPE_MAX_LENGTH')) {
        userMessage +=
          "Sorry, that response was too long! I'll try to be more concise next time.";
      } else if (error.message.includes('Invalid string length')) {
        userMessage +=
          "I had trouble formatting the menu options. I'll try to keep them simpler next time!";
      } else if (error.message.includes('Network error')) {
        userMessage +=
          "I'm having trouble connecting to my brain right now. Please try again in a moment.";
      } else if (error.details?.errorText) {
        userMessage += `There was a problem: ${error.details.errorText}`;
      } else {
        userMessage +=
          'Something unexpected happened. Please try again or rephrase your request.';
      }

      throw new DiscordError(userMessage);
    }
  }

  // Track response times for metrics
  _calculateAverageResponseTime() {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  _addResponseTime(time) {
    this.responseTimes.push(time);
    if (this.responseTimes.length > this.maxResponseTimes) {
      this.responseTimes.shift(); // Remove oldest
    }
  }

  /**
   * Send a direct message to a user by their Discord user ID
   * @param {string} userId The Discord user ID to send a message to
   * @param {string} message The message content to send
   * @returns {Promise<Message>} The sent message object
   */
  async sendDirectMessage(userId, message) {
    try {
      logger.debug('Attempting to send direct message', {
        userId,
        messageLength: message.length,
      });

      // Fetch the user
      const user = await this.bot.users.fetch(userId);
      if (!user) {
        throw new Error(`Could not find user with ID ${userId}`);
      }

      // Create DM channel if it doesn't exist
      const dmChannel = await user.createDM();

      // Send the message
      const sentMessage = await dmChannel.send(message);

      logger.info('Direct message sent successfully', {
        userId,
        messageId: sentMessage.id,
        channelId: dmChannel.id,
      });

      return sentMessage;
    } catch (error) {
      logger.error('Failed to send direct message', {
        error: {
          message: error.message,
          stack: error.stack,
        },
        userId,
        context: {
          bot_ready: this.bot.isReady(),
        },
      });
      throw new DiscordError(
        `Failed to send DM to user ${userId}: ${error.message}`
      );
    }
  }

  shouldRespond(message) {
    // Log the channel type for debugging
    const isDM = message.channel.type === ChannelType.DM;
    const isBotMessage = message.author.bot;
    const hasMention = message.mentions.has(this.bot.user);
    const channelName = message.channel?.name;

    logger.debug('Message channel type', {
      type: message.channel.type,
      isDM,
      channelName,
      isBot: isBotMessage,
      hasMention,
      authorId: message.author.id,
      messageId: message.id,
      // Add more context about the message
      messageType: message.type,
      channelType: message.channel.type,
      guildId: message.guild?.id,
    });

    // Ignore self and other bots
    if (isBotMessage) {
      logger.debug('Ignoring bot message', { authorId: message.author.id });
      return false;
    }

    // Respond if bot is mentioned
    if (hasMention) {
      logger.debug('Responding to mention', { messageId: message.id });
      return true;
    }

    // Always respond to DMs
    if (isDM) {
      logger.debug('Responding to DM', { messageId: message.id });
      return true;
    }

    // Only check channel name if we have a channel
    const shouldRespondToChannel = channelName?.includes('🤖') || false;
    if (shouldRespondToChannel) {
      logger.debug('Responding to bot channel', { channelName });
    }

    return shouldRespondToChannel;
  }

  // Update _handleInteraction to handle all interaction types cleanly
  async _handleInteraction(interaction) {
    const interactionDetails = this._getInteractionDetails(interaction);
    if (!interactionDetails) return;

    try {
      logger.info('Interaction received', interactionDetails);

      // Defer the update to acknowledge the interaction
      await interaction.deferUpdate();

      // Remove components to prevent duplicate interactions
      await interaction.message.edit({
        components: [],
      });

      // Enhanced interaction message with more context
      const contextMessage = `[Interaction: ${interactionDetails.type}]
User ${interaction.user.username} selected "${interactionDetails.value}"
This was in response to: "${interaction.message.content}"`;

      const result = await capabilitiesClient.chat(contextMessage, interaction);

      // Create a new reply instead of editing
      await interaction.followUp({
        content: result.content,
        components: this._createResponseComponents(result.components),
      });
    } catch (error) {
      logger.error('Failed to handle interaction', {
        error: error.message,
        details: error.details,
        ...interactionDetails,
      });

      try {
        // If we haven't deferred yet, defer the update
        if (!interaction.deferred) {
          await interaction.deferUpdate();
        }

        let userMessage = '❌ ';
        if (error.message.includes('BASE_TYPE_MAX_LENGTH')) {
          userMessage +=
            "Sorry, that response was too long! I'll try to be more concise next time.";
        } else if (error.message.includes('Invalid string length')) {
          userMessage +=
            "I had trouble formatting the menu options. I'll try to keep them simpler next time!";
        } else if (error.message.includes('Network error')) {
          userMessage +=
            "I'm having trouble connecting to my brain right now. Please try again in a moment.";
        } else {
          userMessage +=
            'Something unexpected happened. Please try again or rephrase your request.';
        }

        // Send error as a new message
        await interaction.followUp({
          content: userMessage,
          ephemeral: true, // Only show error to the user who clicked
        });
      } catch (followUpError) {
        logger.error('Failed to send error message', {
          originalError: error,
          followUpError: followUpError,
        });
      }
    }
  }

  // Helper to get consistent interaction details
  _getInteractionDetails(interaction) {
    if (interaction.isButton()) {
      return {
        type: 'Button',
        customId: interaction.customId,
        value: interaction.customId,
        userId: interaction.user.id,
        messageId: interaction.message.id,
      };
    }

    if (interaction.isStringSelectMenu()) {
      return {
        type: 'Select',
        customId: interaction.customId,
        value: interaction.values[0],
        userId: interaction.user.id,
        messageId: interaction.message.id,
      };
    }

    // Add other interaction types here (e.g., modals, context menus)

    return null; // Unsupported interaction type
  }

  // Helper to create response components
  _createResponseComponents(components) {
    const rows = [];

    if (components?.buttons?.length) {
      rows.push(createButtonRow(components.buttons));
    }

    if (components?.selectMenus?.length) {
      components.selectMenus.forEach(options => {
        rows.push({ type: 1, components: [createSelectMenu(options)] });
      });
    }

    return rows;
  }

  // Add new method to check capabilities version
  async checkCapabilitiesVersion() {
    try {
      // Normalize the capabilities URL
      const normalizeUrl = url => {
        const cleanUrl = url.replace(/^(https?:\/\/)/, '');
        return `http://${cleanUrl}`;
      };

      const rawUrl = process.env.CAPABILITIES_URL || '';
      const normalizedUrl = normalizeUrl(rawUrl);
      const healthUrl = `${normalizedUrl}/health`;

      const response = await fetch(healthUrl);
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }

      const data = await response.json();
      this.capabilitiesVersion = data.version;
      return data;
    } catch (error) {
      logger.error('Failed to check capabilities version', {
        error: error.message,
        capabilities_url: process.env.CAPABILITIES_URL,
      });
      return { version: 'unknown', status: 'error' };
    }
  }

  // Add slash command registration
  async registerCommands() {
    try {
      const commands = [
        {
          name: 'health',
          description:
            'Get detailed health information about the bot and capabilities server',
        },
        {
          name: 'help',
          description:
            'Learn about what I can do and how to use me effectively',
          options: [
            {
              name: 'topic',
              type: 3, // STRING
              description: 'Specific topic to get help with',
              required: false,
              choices: [
                { name: '🤖 General Usage', value: 'general' },
                { name: '💬 Chat Features', value: 'chat' },
                { name: '🎮 Interactive Features', value: 'interactive' },
                { name: '📊 Stats & Health', value: 'stats' },
                { name: '⚙️ Technical Details', value: 'technical' },
              ],
            },
          ],
        },
        {
          name: 'memories',
          description:
            'View your recent interactions and memories with Coach Artie',
        },
        {
          name: 'search',
          description: 'Search through your memories with Coach Artie',
          options: [
            {
              name: 'text',
              type: 3, // STRING
              description: 'What would you like to search for?',
              required: true,
            },
          ],
        },
        {
          name: 'vector',
          description: 'Find semantically similar memories (AI-powered search)',
          options: [
            {
              name: 'text',
              type: 3, // STRING
              description: "Describe what you're looking for",
              required: true,
            },
          ],
        },
        {
          name: 'stats',
          description: 'View your personal stats and profile summary',
        },
      ];

      logger.info('Registering slash commands', {
        commands: commands.map(c => c.name),
      });

      // First try to register globally
      try {
        await this.bot.application?.commands.set(commands);
        logger.info('Successfully registered global commands');
      } catch (error) {
        logger.error(
          'Failed to register global commands, trying guild-specific registration',
          {
            error: error.message,
          }
        );

        // If global registration fails, try registering to each guild
        const guilds = this.bot.guilds.cache;
        for (const [guildId, guild] of guilds) {
          try {
            await guild.commands.set(commands);
            logger.info('Registered commands for guild', {
              guildId,
              guildName: guild.name,
            });
          } catch (guildError) {
            logger.error('Failed to register commands for guild', {
              guildId,
              guildName: guild.name,
              error: guildError.message,
            });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to register slash commands', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  // Add slash command handler
  async _handleSlashCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case 'memories': {
          await interaction.deferReply({ ephemeral: true });

          try {
            const memories = await this.getRecentMemories(interaction.user.id);

            // Format memories for display
            const formattedMemories = memories
              .map(memory => {
                const date = new Date(memory.created_at).toLocaleString();
                return `📝 ${date}\n${memory.value}\n`;
              })
              .join('\n');

            const embed = {
              title: '🧠 Your Recent Memories',
              description: formattedMemories || 'No memories found.',
              color: 0x00ff00,
              footer: {
                text: '🔒 Only visible to you',
                icon_url: interaction.user.avatarURL() || undefined,
              },
              timestamp: new Date().toISOString(),
            };

            await interaction.editReply({
              embeds: [embed],
              ephemeral: true,
            });
          } catch (error) {
            logger.error('Failed to fetch memories', {
              error: error.message,
              userId: interaction.user.id,
            });
            await interaction.editReply({
              content:
                '❌ Sorry, I had trouble retrieving your memories. Please try again later.',
              ephemeral: true,
            });
          }
          break;
        }
        case 'help': {
          await interaction.deferReply();
          const topic = interaction.options.getString('topic') || 'general';

          const helpContent = {
            general: {
              title: '🤖 General Usage Guide',
              description: 'Here are the main ways you can interact with me:',
              fields: [
                {
                  name: '💭 Natural Chat',
                  value:
                    'Just talk to me naturally! You can:\n• Mention me with @CoachArtie\n• Use a channel with 🤖 in the name\n• Send me a DM',
                },
                {
                  name: '🔧 Slash Commands',
                  value:
                    'Use / to see all available commands:\n• /help - Show this help\n• /health - Check system status',
                },
                {
                  name: '🎯 Best Practices',
                  value:
                    '• Be specific in your requests\n• One topic at a time works best\n• I can create threads for longer conversations',
                },
              ],
            },
            chat: {
              title: '💬 Chat Capabilities',
              description: 'I can engage in various types of conversations:',
              fields: [
                {
                  name: '🗣️ Natural Language',
                  value:
                    'I understand and respond to natural language, including:\n• Questions\n• Requests\n• Discussions\n• Follow-ups',
                },
                {
                  name: '🧵 Threading',
                  value:
                    "I'll create threads for:\n• Complex topics\n• Multi-step processes\n• Detailed explanations",
                },
                {
                  name: '📝 Context',
                  value:
                    'I maintain context within:\n• The same thread\n• Recent conversations\n• Related topics',
                },
              ],
            },
            interactive: {
              title: '🎮 Interactive Features',
              description:
                'I can create interactive elements to enhance our conversations:',
              fields: [
                {
                  name: '🔘 Buttons',
                  value:
                    'Interactive buttons for:\n• Quick responses\n• Multiple choice\n• Navigation',
                },
                {
                  name: '📝 Select Menus',
                  value:
                    'Dropdown menus for:\n• Multiple options\n• Categories\n• Settings',
                },
                {
                  name: '🔔 Notifications',
                  value:
                    'I can notify you:\n• When tasks complete\n• For important updates\n• At requested times',
                },
              ],
            },
            stats: {
              title: '📊 Stats & Health Features',
              description: 'Monitor and check system status:',
              fields: [
                {
                  name: '🏥 Health Checks',
                  value:
                    '• /health - Full system status\n• Status emoji in my presence\n• Version information',
                },
                {
                  name: '📈 Statistics',
                  value:
                    '• Users helped\n• Messages processed\n• System uptime',
                },
                {
                  name: '⚡ Performance',
                  value: '• Response times\n• Queue status\n• Service health',
                },
              ],
            },
            technical: {
              title: '⚙️ Technical Details',
              description: 'Advanced information about my capabilities:',
              fields: [
                {
                  name: '🔌 System Architecture',
                  value:
                    '• Discord Bot (v' +
                    (process.env.npm_package_version || '1.0.4') +
                    ')\n• Capabilities Server\n• Task Queue System',
                },
                {
                  name: '🔧 Configuration',
                  value:
                    '• Bot channels (🤖)\n• DM support\n• Thread management',
                },
                {
                  name: '📚 Resources',
                  value: '• Documentation\n• Support channels\n• Update logs',
                },
              ],
            },
          };

          const content = helpContent[topic];
          if (!content) {
            await interaction.editReply(
              'Topic not found. Try one of the available topics!'
            );
            return;
          }

          const embed = {
            title: content.title,
            description: content.description,
            color: 0x00ff00, // Green
            fields: content.fields,
            footer: {
              text: 'Tip: Use the topic dropdown to see other help categories!',
            },
          };

          await interaction.editReply({
            embeds: [embed],
            ephemeral: true, // Only show to the user who requested
          });
          break;
        }
        case 'health': {
          await interaction.deferReply();

          const botVersion = process.env.npm_package_version || '1.0.4';
          const capabilities = await this.checkCapabilitiesVersion();
          const botUptime = Math.round(process.uptime());
          const memoryUsage = process.memoryUsage();

          const statusEmoji =
            capabilities.status === 'healthy'
              ? '🟢'
              : capabilities.status === 'degraded'
              ? '🟡'
              : '🔴';

          const formatBytes = bytes => {
            return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MB`;
          };

          const formatUptime = seconds => {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${days}d ${hours}h ${minutes}m`;
          };

          const response = [
            '**🤖 Discord Bot Status**',
            `Version: ${botVersion}`,
            `Uptime: ${formatUptime(botUptime)}`,
            `Memory: ${formatBytes(memoryUsage.heapUsed)} / ${formatBytes(
              memoryUsage.heapTotal
            )}`,
            `Messages Processed: ${this.messageCount}`,
            `Unique Users: ${this.uniqueUsers.size}`,
            `Error Count: ${this.errorCount}`,
            '',
            '**⚡ Capabilities Server Status**',
            `Version: ${capabilities.version}`,
            `Status: ${statusEmoji} ${capabilities.status || 'unknown'}`,
          ];

          // Add queue info if available
          if (capabilities.queue) {
            response.push(
              `Queue Status: ${capabilities.queue.pending} pending, ${capabilities.queue.processing} processing, ${capabilities.queue.failed} failed`
            );
          }

          // Add service status if available
          if (capabilities.services) {
            response.push(
              '',
              '**🔌 Services Status**',
              Object.entries(capabilities.services)
                .map(
                  ([service, status]) => `${service}: ${status ? '✅' : '❌'}`
                )
                .join('\n')
            );
          }

          await interaction.editReply({
            content: response.join('\n'),
            ephemeral: true, // Only show to the user who requested
          });
          break;
        }
        case 'search': {
          await interaction.deferReply({ ephemeral: true });

          try {
            const searchText = interaction.options.getString('text');
            const memories = await this.searchMemories(
              interaction.user.id,
              searchText
            );

            const formattedMemories = memories
              .map(memory => {
                const date = new Date(memory.created_at).toLocaleString();
                return `📝 ${date}\n${memory.value}\n`;
              })
              .join('\n');

            const embed = {
              title: `🔍 Search Results: "${searchText}"`,
              description: formattedMemories || 'No matching memories found.',
              color: 0x00ff00,
              footer: {
                text: '🔒 Only visible to you',
                icon_url: interaction.user.avatarURL() || undefined,
              },
              timestamp: new Date().toISOString(),
            };

            await interaction.editReply({
              embeds: [embed],
              ephemeral: true,
            });
          } catch (error) {
            logger.error('Search failed', {
              error: error.message,
              userId: interaction.user.id,
              query: interaction.options.getString('text'),
            });
            await interaction.editReply({
              content:
                '❌ Sorry, I had trouble searching your memories. Please try again later.',
              ephemeral: true,
            });
          }
          break;
        }
        case 'vector': {
          await interaction.deferReply({ ephemeral: true });

          try {
            const searchText = interaction.options.getString('text');
            const memories = await this.vectorSearchMemories(
              interaction.user.id,
              searchText
            );

            const formattedMemories = memories
              .map(memory => {
                const date = new Date(memory.created_at).toLocaleString();
                const similarity = Math.round(memory.similarity * 100);
                return `📝 ${date} (${similarity}% match)\n${memory.value}\n`;
              })
              .join('\n');

            const embed = {
              title: `🧠 AI Search Results: "${searchText}"`,
              description: formattedMemories || 'No similar memories found.',
              color: 0x00ff00,
              footer: {
                text: '🔒 Only visible to you • Powered by AI similarity matching',
                icon_url: interaction.user.avatarURL() || undefined,
              },
              timestamp: new Date().toISOString(),
            };

            await interaction.editReply({
              embeds: [embed],
              ephemeral: true,
            });
          } catch (error) {
            logger.error('Vector search failed', {
              error: error.message,
              userId: interaction.user.id,
              query: interaction.options.getString('text'),
            });
            await interaction.editReply({
              content:
                '❌ Sorry, I had trouble performing the AI search. Please try again later.',
              ephemeral: true,
            });
          }
          break;
        }
        case 'stats': {
          await interaction.deferReply({ ephemeral: true });

          try {
            const userId = interaction.user.id;
            const supabase = this.getSupabase();

            // Get total memory count
            const { count: totalMemories } = await supabase
              .from(DB_TABLES.MEMORY)
              .select('*', { count: 'exact', head: true })
              .eq('user_id', userId);

            // Get first memory date
            const { data: firstMemory } = await supabase
              .from(DB_TABLES.MEMORY)
              .select('created_at')
              .eq('user_id', userId)
              .order('created_at', { ascending: true })
              .limit(1);

            // Get recent memories for summary
            const { data: recentMemories } = await supabase
              .from(DB_TABLES.MEMORY)
              .select('value, created_at')
              .eq('user_id', userId)
              .order('created_at', { ascending: false })
              .limit(5);

            // Calculate active days
            const firstDate = firstMemory?.[0]?.created_at;
            const daysSinceFirst = firstDate
              ? Math.round(
                  (Date.now() - new Date(firstDate).getTime()) /
                    (1000 * 60 * 60 * 24)
                )
              : 0;

            // Format the stats embed
            const embed = {
              title: `📊 Personal Stats for ${interaction.user.username}`,
              color: 0x00ff00,
              thumbnail: {
                url: interaction.user.avatarURL() || undefined,
              },
              fields: [
                {
                  name: '🧠 Memory Stats',
                  value: [
                    `Total Memories: ${totalMemories || 0}`,
                    `First Memory: ${
                      firstDate
                        ? new Date(firstDate).toLocaleDateString()
                        : 'No memories yet'
                    }`,
                    `Days Active: ${daysSinceFirst}`,
                    `Average Memories/Day: ${
                      totalMemories
                        ? (totalMemories / Math.max(daysSinceFirst, 1)).toFixed(
                            1
                          )
                        : 0
                    }`,
                  ].join('\n'),
                },
                {
                  name: '🕒 Recent Activity',
                  value: recentMemories?.length
                    ? recentMemories
                        .map(
                          mem =>
                            `• ${new Date(
                              mem.created_at
                            ).toLocaleDateString()}: ${
                              mem.value.length > 60
                                ? mem.value.substring(0, 60) + '...'
                                : mem.value
                            }`
                        )
                        .join('\n')
                    : 'No recent memories',
                },
              ],
              footer: {
                text: '🔒 Stats are private and only visible to you',
                icon_url: interaction.user.avatarURL() || undefined,
              },
              timestamp: new Date().toISOString(),
            };

            await interaction.editReply({
              embeds: [embed],
              ephemeral: true,
            });
          } catch (error) {
            logger.error('Failed to fetch user stats', {
              error: error.message,
              userId: interaction.user.id,
            });
            await interaction.editReply({
              content:
                '❌ Sorry, I had trouble retrieving your stats. Please try again later.',
              ephemeral: true,
            });
          }
          break;
        }
      }
    } catch (error) {
      logger.error('Slash command error', {
        command: interaction.commandName,
        error: error.message,
        stack: error.stack,
      });

      const errorMessage = 'Failed to execute command. Please try again later.';

      if (interaction.deferred) {
        await interaction.editReply({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }

  // Add dedicated method for memory retrieval
  async getRecentMemories(userId, limit = 5) {
    try {
      const supabase = this.getSupabase();
      const { data, error } = await supabase
        .from(DB_TABLES.MEMORY)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Failed to fetch memories from database', {
          error: error.message,
          userId,
        });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error in getRecentMemories', {
        error: error.message,
        userId,
      });
      throw error;
    }
  }

  // Add the search methods
  async searchMemories(userId, query, limit = 5) {
    try {
      const supabase = this.getSupabase();
      const { data, error } = await supabase
        .from(DB_TABLES.MEMORY)
        .select('*')
        .eq('user_id', userId)
        .textSearch('value', query) // Using Supabase text search
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Failed to search memories', {
          error: error.message,
          userId,
          query,
        });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error in searchMemories', {
        error: error.message,
        userId,
        query,
      });
      throw error;
    }
  }

  async vectorSearchMemories(userId, query, limit = 5) {
    try {
      const supabase = this.getSupabase();
      const { data, error } = await supabase.rpc('match_memories', {
        query_embedding: await this.getEmbedding(query),
        match_threshold: 0.7,
        match_count: limit,
        p_user_id: userId,
      });

      if (error) {
        logger.error('Failed to perform vector search', {
          error: error.message,
          userId,
          query,
        });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('Error in vectorSearchMemories', {
        error: error.message,
        userId,
        query,
      });
      throw error;
    }
  }

  async getEmbedding(text) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer':
            process.env.OPENROUTER_REFERER || 'http://localhost:3000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: text,
          model: 'openai/text-embedding-ada-002', // OpenRouter's format for OpenAI models
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      logger.error('Failed to get embedding', {
        error: error.message,
        text: text.substring(0, 100), // Log first 100 chars
      });
      throw error;
    }
  }
}

// Start the bot if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  logger.info('Starting bot as main module', {
    argv: process.argv,
    node_env: process.env.NODE_ENV,
  });
  bot = new DiscordBot();
}

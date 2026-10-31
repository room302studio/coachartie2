/**
 * The gateway: the Discord client, its event handlers and watchers, the OUTGOING_DISCORD push
 * worker, the :47321 API and the 127.0.0.1:47319 health server.
 *
 * Wave 9 (one process): this module no longer runs itself, loads .env, or installs signal and
 * crash handlers. src/main.ts does those once for the whole bot and calls startGateway() after
 * the engine is up; its one SIGINT/SIGTERM handler calls the returned stop().
 */
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { logger } from '../shared/logger.js';
import { getErrorMessage } from '../shared/errors.js';
import { setupMessageHandler } from './1-receive/on-message.js';
import { setupInteractionHandler } from './1-receive/on-interaction.js';
import { setupReactionHandler } from './1-receive/on-reaction.js';
import { startResponseConsumer } from './watchers/push-worker.js';
import { publishMessage } from '../shared/queue/enqueue-message.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { telemetry } from './telemetry.js';
import { healthServer } from './health.js';
import { apiServer } from './http.js';
import { pathResolver } from './path-resolver.js';
import { jobMonitor } from './3-ask-engine/job-watcher.js';
import { initializeForumTraversal } from './watchers/github/forum-traversal.js';
import { initializeGitHubIntegration } from './watchers/github/issue-sync.js';
import { initializeMentionProxyService } from './2-gate/mention-proxy.js';
import { initializeGitHubSync, stopGitHubSync } from './watchers/github/watch-loop.js';
import { observationalLearning } from './watchers/observe-channels.js';
import { steamReviewNotes } from './watchers/steam-review-notes.js';
import { channelDigestLoop } from './watchers/channel-digests.js';
import { initAutoScribe, stopAutoScribe } from './voice/scribe-auto.js';
import { registerGatewayClient } from './api.js';
import { stopAllVoiceScribeSessions } from './voice/scribe-session.js';

/**
 * Privileged intents (GuildMembers, MessageContent) need Discord's app verification once a
 * bot reaches 10k users, and Subway Builder put Artie over it: the portal refuses to turn them
 * on (2026-10-21), and asking for them anyway makes login fail with "Used disallowed intents".
 * Without MessageContent Discord still delivers the text of DMs, messages that @mention
 * Artie, and his own messages, which is all mention-only Artie strictly needs; channel
 * history and digests go quiet until verification lands. Then set
 * DISCORD_PRIVILEGED_INTENTS=true (and restart with --update-env).
 */
export const privilegedIntents = process.env.DISCORD_PRIVILEGED_INTENTS === 'true';

/**
 * Intent bits for optional privileged intents, if enabled.
 */
function privilegedIntentBits(): GatewayIntentBits[] {
  if (privilegedIntents) {
    return [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent];
  }
  return [];
}

/**
 * Format environment variable status for logs.
 */
function envStatus(value: string | undefined): string {
  if (value) {
    return '✅ Set';
  }
  return '❌ Missing';
}

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildIntegrations,
    GatewayIntentBits.GuildMessageReactions,
    // Non-privileged (no portal flag, no verification gate) — needed for /scribe to see who's
    // in a voice channel (join/leave events, member counts for auto-stop). Voice RECEIVE itself
    // (@discordjs/voice) doesn't need an intent; this just keeps the voice-state cache warm.
    GatewayIntentBits.GuildVoiceStates,
    ...privilegedIntentBits(),
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User, Partials.Reaction],
  // SAFETY: never let Artie ping @everyone/@here or roles, no matter what text he posts.
  // Only user mentions resolve. (Users tricked him into echoing "@everyone" — this neuters it.)
  allowedMentions: { parse: ['users'] },
});

// The raw-message debug log and GitHub-identity learning that used to be a second
// MessageCreate listener here are now the first step of 1-receive/on-message.ts (wave 5).

// Write status to shared file
function writeStatus(status: 'starting' | 'ready' | 'error' | 'shutdown', data?: any) {
  try {
    let guildInfo: Array<{ name: string; memberCount: number; channels: number; id: string }> = [];
    let totalChannels = 0;
    let totalMembers = 0;

    if (client.guilds && client.isReady()) {
      guildInfo = client.guilds.cache.map((guild) => ({
        name: guild.name,
        memberCount: guild.memberCount,
        channels: guild.channels.cache.size,
        id: guild.id,
      }));

      totalChannels = client.guilds.cache.reduce(
        (total, guild) => total + guild.channels.cache.size,
        0
      );
      totalMembers = client.guilds.cache.reduce(
        (total, guild) => total + (guild.memberCount || 0),
        0
      );
    }

    const statusData = {
      status,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      guilds: client.guilds?.cache.size || 0,
      guildDetails: guildInfo,
      totalChannels,
      totalMembers,
      uptime: process.uptime(),
      ...data,
    };

    // Silently write status file using environment-aware path resolution
    const statusFile = pathResolver.getStatusFilePath();
    writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
  } catch (error) {
    logger.error('Failed to write status file:', error);
  }
}

export interface GatewayHandle {
  /** True when both the :47321 API and the :47319 health server are listening. */
  listening: boolean;
  /** Stop everything startGateway started, in reverse order. Never exits the process. */
  stop(signal?: string): Promise<void>;
}

/**
 * Start the gateway: event handlers, the OUTGOING_DISCORD push worker, Discord login. At
 * ClientReady (as before) the health server and the API start listening and the client is
 * registered in gateway/api.ts for the engine. Resolves once Discord is ready and both
 * listeners have started (or failed, which is logged, as before, and reported in `listening`).
 * A login failure rejects, after writing the 'error' status file.
 */
export async function startGateway(): Promise<GatewayHandle> {
  console.log('🚀 DISCORD SERVICE STARTING UP - BOOKITY BOOKITY!');
  console.log('🔌 Environment check:');
  console.log('  - DISCORD_TOKEN:', envStatus(process.env.DISCORD_TOKEN));
  console.log('  - REDIS_HOST:', process.env.REDIS_HOST || 'not set');
  console.log('  - REDIS_PORT:', process.env.REDIS_PORT || 'not set');
  console.log('  - DISCORD_PORT:', process.env.DISCORD_PORT || 'not set');

  // Settled by the ClientReady handler with the two listeners' start promise (boxed, so
  // awaiting clientReady doesn't also await the listeners).
  let markReady!: (ready: { listeners: Promise<unknown> }) => void;
  const clientReady = new Promise<{ listeners: Promise<unknown> }>((resolve) => {
    markReady = resolve;
  });
  let statusTimer: NodeJS.Timeout | null = null;

  console.log('🎯 Start function called - SNOOKITY LOOKITY!');
  try {
    console.log('📝 Writing starting status...');
    writeStatus('starting');

    console.log('🎮 Setting up event handlers...');
    // Setup event handlers
    client.on(Events.ClientReady, () => {
      console.log('✨ CLIENT READY EVENT FIRED - FLUCKED AND BUCKED!');
      logger.info(`✅ discord: ${client.user?.tag} [${client.guilds.cache.size} guilds]`);

      // Update telemetry with connection info
      const guildCount = client.guilds.cache.size;
      const channelCount = client.guilds.cache.reduce(
        (total, guild) => total + guild.channels.cache.size,
        0
      );
      telemetry.updateConnectionMetrics(guildCount, channelCount);
      telemetry.logEvent('discord_ready', {
        username: client.user?.tag,
        guilds: guildCount,
        channels: channelCount,
      });

      // Start health server, and the API server for forum access
      healthServer.setDiscordClient(client);
      apiServer.setDiscordClient(client);
      markReady({ listeners: Promise.all([healthServer.start(), apiServer.start()]) });

      // From here the engine reaches Discord through gateway/api.ts (wave 9): the same
      // moment the :47321 server used to start answering its HTTP calls.
      registerGatewayClient(client);

      // Start the persistent job monitor (single wheel for all jobs)
      jobMonitor.startMonitoring();

      // Initialize forum traversal service
      try {
        console.log('🔧 Initializing forum traversal...');
        initializeForumTraversal(client);
        logger.info('✅ Forum traversal service enabled');
      } catch (error) {
        logger.warn('Failed to initialize forum traversal:', error);
        console.error('❌ Forum traversal init failed:', error);
      }

      // Initialize mention proxy service
      try {
        console.log('🔧 Initializing mention proxy service...');
        initializeMentionProxyService();
        logger.info('✅ Mention proxy service enabled');
      } catch (error) {
        logger.warn('Failed to initialize mention proxy service:', error);
        console.error('❌ Mention proxy service init failed:', error);
      }

      // Initialize GitHub integration (if token provided)
      try {
        console.log('🔧 Checking GitHub integration...');
        if (process.env.GITHUB_TOKEN) {
          initializeGitHubIntegration();
          logger.info('✅ GitHub integration enabled');
          console.log('✅ GitHub integration enabled');
        } else {
          logger.info('ℹ️  GitHub integration disabled (no GITHUB_TOKEN)');
          console.log('ℹ️  GitHub integration disabled (no GITHUB_TOKEN)');
        }
      } catch (error) {
        logger.warn('Failed to initialize GitHub integration:', error);
        console.error('❌ GitHub integration init failed:', error);
      }

      // Steam launch countdown (Sterling Artie milestone posts in #prison; self-disarms after launch)
      import('./games/launch-countdown.js').then(({ initializeLaunchCountdown }) => {
        initializeLaunchCountdown(client);
      }).catch((error) => {
        logger.warn('Failed to initialize launch countdown:', error);
        console.error('❌ Launch countdown init failed:', error);
      });

      // Initialize GitHub Identity Resolver (auto-maps GitHub → Discord users)
      // Initialize GitHub Studio Manager (daily digests, stale PR nudges)
      if (process.env.GITHUB_TOKEN) {
        import('./watchers/github/identity-resolver.js').then(({ initializeIdentityResolver }) => {
          initializeIdentityResolver(client);
          logger.info('✅ GitHub identity resolver enabled');
          console.log('✅ GitHub identity resolver enabled');
        }).catch((error) => {
          logger.warn('Failed to initialize identity resolver:', error);
          console.error('❌ Identity resolver init failed:', error);
        });

        import('./watchers/github/studio-digest.js').then(({ initializeStudioManager }) => {
          initializeStudioManager(client);
          logger.info('✅ GitHub studio manager enabled');
          console.log('✅ GitHub studio manager enabled');
        }).catch((error) => {
          logger.warn('Failed to initialize studio manager:', error);
          console.error('❌ Studio manager init failed:', error);
        });

        import('./watchers/github/org-watcher.js').then(({ initializeOrgWatcher }) => {
          initializeOrgWatcher(client);
          logger.info('✅ GitHub org watcher enabled');
          console.log('✅ GitHub org watcher enabled');
        }).catch((error) => {
          logger.warn('Failed to initialize org watcher:', error);
          console.error('❌ Org watcher init failed:', error);
        });
      }

      // Initialize GitHub Sync service (PR/CI notifications)
      try {
        console.log('🔧 Checking GitHub Sync service...');
        if (process.env.GITHUB_TOKEN) {
          initializeGitHubSync(client)
            .then(() => {
              logger.info('✅ GitHub Sync service enabled');
              console.log('✅ GitHub Sync service enabled');
            })
            .catch((err) => {
              logger.warn('GitHub Sync initialization failed:', err);
              console.error('❌ GitHub Sync init failed:', err);
            });
        } else {
          logger.info('ℹ️  GitHub Sync disabled (no GITHUB_TOKEN)');
          console.log('ℹ️  GitHub Sync disabled (no GITHUB_TOKEN)');
        }
      } catch (error) {
        logger.warn('Failed to initialize GitHub Sync:', error);
        console.error('❌ GitHub Sync init failed:', error);
      }

      // Initialize observational learning
      try {
        console.log('🔧 Initializing observational learning...');
        observationalLearning.initialize(client);
        logger.info('✅ Observational learning enabled');
        console.log('✅ Observational learning enabled');
      } catch (error) {
        logger.warn('Failed to initialize observational learning:', error);
        console.error('❌ Observational learning init failed:', error);
      }

      // Channel digests: one cheap rolling summary per observed channel (replaces the firehose)
      try {
        channelDigestLoop.initialize(client);
      } catch (error) {
        logger.warn('Failed to initialize channel digests:', error);
      }

      // Auto-scribe: join a scheduled meeting on his own, summarize, leave (scribe-auto.ts)
      try {
        initAutoScribe(client);
      } catch (error) {
        logger.warn('Failed to initialize auto-scribe:', error);
      }

      // Initialize Steam review note-taking (#steam-reviews → ongoing situation doc)
      try {
        steamReviewNotes.initialize(client);
        logger.info('✅ Steam review notes enabled');
        console.log('✅ Steam review notes enabled');
      } catch (error) {
        logger.warn('Failed to initialize Steam review notes:', error);
        console.error('❌ Steam review notes init failed:', error);
      }

      writeStatus('ready', {
        username: client.user?.tag,
        guilds: client.guilds.cache.size,
        permissions: client.user?.flags?.bitfield || 'none',
      });

      // Refresh status file every 30 minutes so other processes get live guild counts
      statusTimer = setInterval(() => {
        writeStatus('ready', {
          username: client.user?.tag,
          guilds: client.guilds.cache.size,
          permissions: client.user?.flags?.bitfield || 'none',
        });
      }, 30 * 60 * 1000);
    });

    client.on(Events.Error, (error) => {
      logger.error('Discord client error:', error);
      telemetry.incrementApiErrors(error.message);
      telemetry.logEvent(
        'discord_error',
        { error: error.message },
        undefined,
        undefined,
        undefined,
        false
      );
      writeStatus('error', { error: error.message });
    });

    client.on('reconnecting', () => {
      logger.warn('Discord client reconnecting...');
      telemetry.incrementReconnections();
      telemetry.logEvent('discord_reconnecting');
    });

    // Setup message handler
    console.log('📬 Setting up message handler...');
    setupMessageHandler(client);

    // Setup interaction handler for slash commands
    console.log('🎯 Setting up interaction handler...');
    setupInteractionHandler(client);

    // Setup reaction handler for two-way reactions
    console.log('⚡ Setting up reaction handler...');
    setupReactionHandler(client);

    // Start queue consumer for responses
    console.log('🚀 Starting queue consumer...');
    const pushWorker = await startResponseConsumer(client);

    // Login to Discord
    console.log('🔐 Attempting Discord login...');
    console.log('   Token exists:', !!process.env.DISCORD_TOKEN);
    console.log('   Token length:', process.env.DISCORD_TOKEN?.length);
    await client.login(process.env.DISCORD_TOKEN);
    console.log('✅ Discord login successful!');

    // Status updates disabled - only update on actual state changes
    // This reduces log spam and Clickhouse costs

    const listening = await (await clientReady).listeners.then(
      () => true,
      () => false // each server already logged its own listen error
    );

    return {
      listening,
      async stop(signal = 'shutdown') {
        // Reverse of start: stop answering the engine and the network first, then the
        // watchers, the push worker, and finally the Discord connection.
        logger.info(`${signal} received, shutting down Discord bot`);
        telemetry.logEvent('shutdown', { signal });
        telemetry.persistMetrics();
        writeStatus('shutdown');
        // GitHub feed first (2026-10-31): post the batches still inside their 15-min window
        // while Discord is connected; the poll cursors are already past them. Self-capped.
        await stopGitHubSync().catch((error) =>
          logger.warn('GitHub shutdown flush failed:', getErrorMessage(error))
        );
        // MUST run before registerGatewayClient(null)/apiServer.stop(): finishing a scribe
        // session's summary calls back into the engine (stopScribeSession), which posts the
        // result through gateway/api.ts's sendChannelMessage — that throws
        // GatewayUnavailableError once the live client is unregistered. Best-effort — a
        // summary call that fails here just means the session's row is left for the
        // retention sweep rather than losing the process over it.
        await stopAllVoiceScribeSessions('shutdown').catch((error) =>
          logger.warn('🎙️ Scribe shutdown sweep failed:', getErrorMessage(error))
        );
        registerGatewayClient(null);
        await healthServer.stop();
        await apiServer.stop();
        jobMonitor.stopMonitoring();
        observationalLearning.shutdown();
        steamReviewNotes.shutdown();
        channelDigestLoop.stop();
        stopAutoScribe();
        if (statusTimer) clearInterval(statusTimer);
        if (pushWorker) await pushWorker.close();
        client.destroy();
        logger.info('✅ Gateway stopped');
      },
    };
  } catch (error) {
    logger.error('Failed to start Discord bot:', error);
    const errorMessage = getErrorMessage(error);
    writeStatus('error', { error: errorMessage });
    throw error;
  }
}

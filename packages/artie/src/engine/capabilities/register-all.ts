import { logger } from '../../shared/logger.js';
import { capabilityRegistry } from './registry.js';
import { undeclaredActions, strayDeclarations } from './policy.js';
// System capabilities
import { calculatorCapability } from './core/calculator.js';
import { sbChangelogCapability } from './core/sb-changelog.js';
import { creditStatusCapability } from './ops/credit-status.js';
// bot-config = runtime_config + model_manager (wave 4; old names alias in registry.ts)
import { botConfigCapability } from './ops/bot-config.js';
import { systemMonitorCapability } from './ops/system-monitor.js';
import { sequenceCapability } from './ops/sequence.js';
import { contextCapability } from './core/context.js';
import { diagnoseCapability } from './ops/diagnose.js';
import { userProfileCapability } from './people/user-profile.js';
import { autonomousCapability } from './ops/autonomous.js';
import { pairingCapability } from './people/pairing.js';
// approvals = the owner-review queue for approval-gate.ts's gated (money / outside-Discord) calls
import { approvalsCapability } from './ops/approvals.js';
// Web capabilities
import { webCapability } from './core/web.js';
import { httpCapability } from './core/http.js';
import { mediaWikiCapability } from './web/mediawiki.js';
import { wolframCapability } from './web/wolfram.js';
import { n8nBrowserCapability } from './web/n8n-browser.js';
// Development capabilities. package_manager, system_installer and environment (.env
// read/write) ran on the production host with zero use; removed 2026-10-23.
import { filesystemCapability } from './dev/filesystem.js';
import { githubCapability } from './dev/github.js';
// sandbox = shell + edit + git + search(dev), all docker exec into the sandbox container
import { sandboxCapability } from './dev/sandbox.js';
// Memory capabilities
import { memoryCapability } from './core/memory.js';
// AI capabilities
import { visionCapability } from './media/vision.js';
import { imageGenCapability } from './media/image-gen.js';
// Productivity capabilities
// tasks = todo + quests + task-status (told apart by `tracker`)
import { tasksCapability } from './planning/tasks.js';
import { schedulerCapability } from './core/reminders.js';
import { promisesCapability } from './core/promises.js';
import { scratchpadCapability } from './planning/scratchpad.js';
import { flashcardCapability } from './planning/flashcard.js';
import { quizGameCapability } from './planning/quiz-game.js';
import { morningBriefingCapability } from '../proactive/morning-briefing.js';
// goals absorbs the old `goal` tool (alias in registry.ts)
import { goalsCapability } from './planning/goals.js';
// Discord capabilities
import { discordUICapability } from './discord/ui.js';
import { discordForumsCapability } from './discord/forums.js';
import { discordModerationCapability } from './discord/moderation.js';
import { discordPollCapability } from './discord/poll.js';
import { discordReactionCapability } from './discord/reaction.js';
import { stripePaymentsCapability } from './money/stripe.js';
import { discordNicknameCapability } from './discord/nickname.js';
import { discordThreadsCapability } from './discord/threads.js';
import { discordSendMessageCapability } from './discord/send-message.js';
import { discordChannelsCapability } from './discord/channels.js';
import { discordSearchCapability } from './discord/search.js';
import { discordUserHistoryCapability } from './discord/user-history.js';
import { discordIssueParserCapability } from './discord/issue-parser.js';
import { sendMetroFileCapability } from './discord/send-metro-file.js';
// Communication capabilities
import { mentionProxyCapability } from './people/mention-proxy.js';
import { emailCapability } from './people/email.js';
import { redditCapability } from './personal/reddit.js';
import { proactiveDMCapability } from '../proactive/proactive-dm.js';
import { relayCapability } from '../proactive/relay.js';
// Analytics capabilities
import { selfStatsCapability } from './ops/self-stats.js';
import { communityAnalyticsCapability } from './ops/community-analytics.js';
// Media capabilities
import { ttsCapability } from './media/tts.js';
import { scribeCapability } from './media/scribe.js';
// Research capabilities
import { deepResearchCapability } from './research/deep-research.js';
import { trendWatcherCapability } from '../proactive/trend-watcher.js';
// Cross-agent capabilities
import { kanbanCapability } from './agents/kanban.js';
import { vpsClaudeCapability } from './agents/vps-claude.js';
import { hermesCapability } from './agents/hermes.js';
import { systemMemoryCapability } from './agents/system-memory.js';
import { osintLookupCapability } from './agents/osint-lookup.js';
// Services
import { meetingCapability } from './people/meeting.js';
// Formerly self-registered at registry.ts load (wave 7 moved them here)
import { embeddedMCPCapability } from './ops/embedded-mcp.js';
import { scrapbookCapability } from './personal/scrapbook.js';

// =====================================================
// CAPABILITY BOOTSTRAP SERVICE
// Handles initialization and registration of all capabilities
// =====================================================

class CapabilityBootstrap {
  private static instance: CapabilityBootstrap;
  private initialized = false;

  static getInstance(): CapabilityBootstrap {
    if (!CapabilityBootstrap.instance) {
      CapabilityBootstrap.instance = new CapabilityBootstrap();
    }
    return CapabilityBootstrap.instance;
  }

  /**
   * Initialize the capability registry with all available capabilities
   * This bridges the gap between capability files and the registry system
   */
  initializeCapabilityRegistry(): void {
    if (this.initialized) {
      logger.info('✅ Capability registry already initialized, skipping');
      return;
    }

    logger.info('🔧 Initializing capability registry with existing capabilities');

    try {
      // Register all capabilities (registration is idempotent, keyed by name).
      // embedded_mcp and scrapbook come first: they used to self-register when
      // registry.ts loaded, i.e. before this ran, and list() order is the roster
      // order in the cached system prompt.
      const ALL_CAPABILITIES = [
        embeddedMCPCapability, scrapbookCapability,
        calculatorCapability, sbChangelogCapability, webCapability, httpCapability,
        filesystemCapability, memoryCapability,
        githubCapability, creditStatusCapability, botConfigCapability,
        systemMonitorCapability, tasksCapability,
        meetingCapability, discordUICapability, discordForumsCapability,
        discordModerationCapability, mentionProxyCapability, emailCapability, proactiveDMCapability,
        userProfileCapability, pairingCapability, approvalsCapability, mediaWikiCapability, wolframCapability,
        schedulerCapability, promisesCapability, sequenceCapability, sandboxCapability,
        scratchpadCapability, selfStatsCapability,
        communityAnalyticsCapability, contextCapability, visionCapability, imageGenCapability,
        diagnoseCapability, autonomousCapability, n8nBrowserCapability, flashcardCapability,
        quizGameCapability, redditCapability, deepResearchCapability,
        trendWatcherCapability, morningBriefingCapability,
        goalsCapability, kanbanCapability, vpsClaudeCapability, hermesCapability,
        systemMemoryCapability, osintLookupCapability, discordPollCapability,
        discordReactionCapability, stripePaymentsCapability, discordNicknameCapability,
        discordThreadsCapability, discordSendMessageCapability, discordChannelsCapability,
        discordSearchCapability,
        discordUserHistoryCapability, discordIssueParserCapability, sendMetroFileCapability,
        relayCapability, ttsCapability, scribeCapability,
      ];
      for (const capability of ALL_CAPABILITIES) {
        capabilityRegistry.register(capability);
      }

      // Initialize OpenClaw-compatible skill system (async, runs after main init)
      logger.info('🦞 Scheduling OpenClaw skill system initialization...');
      setImmediate(async () => {
        try {
          const { skillRegistry, skillsCapability } = await import('./skills/registry.js');
          capabilityRegistry.register(skillsCapability);
          await skillRegistry.initialize();
          logger.info(`🦞 Skills system ready: ${skillRegistry.size()} skills loaded`);
        } catch (skillError) {
          logger.warn('⚠️ Skill system initialization failed (non-fatal):', skillError);
        }
      });

      // Policy coverage (policy.ts): undeclared actions run open, so say so once, loudly.
      const undeclared = undeclaredActions(capabilityRegistry.list());
      if (undeclared.length > 0) {
        const tools = new Set(undeclared.map((a) => a.split(':')[0]));
        logger.warn(
          `🔓 Tool policy: ${undeclared.length} actions on ${tools.size} tools have no declared effect and run with no gates: ${[...tools].join(', ')}`
        );
      }
      const stray = strayDeclarations(capabilityRegistry.list());
      if (stray.length > 0) {
        logger.warn(`🔓 Tool policy: declared but not supported (typo?): ${stray.join(', ')}`);
      }

      const totalCaps = capabilityRegistry.list().length;
      logger.info(
        `✅ Capability registry initialized successfully: ${totalCaps} capabilities registered`
      );
      logger.info(
        `📋 Registered: ${capabilityRegistry
          .list()
          .map((c) => c.name)
          .join(', ')}`
      );

      this.initialized = true;
    } catch (_error) {
      logger.error('❌ Failed to initialize capability registry:', _error);
      logger.error('Stack:', _error);
      // Don't throw - allow service to continue with legacy handlers
    }
  }
}

export const capabilityBootstrap = CapabilityBootstrap.getInstance();

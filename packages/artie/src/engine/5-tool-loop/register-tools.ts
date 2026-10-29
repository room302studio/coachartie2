import { logger } from '../../shared/logger.js';
import { capabilityRegistry } from './registry.js';
// System capabilities
import { calculatorCapability } from '../tools/core/calculator.js';
import { sbChangelogCapability } from '../tools/core/sb-changelog.js';
import { creditStatusCapability } from '../tools/ops/credit-status.js';
// bot-config = runtime_config + model_manager (wave 4; old names alias in registry.ts)
import { botConfigCapability } from '../tools/ops/bot-config.js';
import { systemMonitorCapability } from '../tools/ops/system-monitor.js';
import { variableStoreCapability } from './variables.js';
import { sequenceCapability } from '../tools/ops/sequence.js';
import { contextCapability } from '../tools/core/context.js';
import { diagnoseCapability } from '../tools/ops/diagnose.js';
import { userProfileCapability } from '../tools/people/user-profile.js';
import { autonomousCapability } from '../tools/ops/autonomous.js';
import { pairingCapability } from '../tools/people/pairing.js';
// approvals = the owner-review queue for approval-gate.ts's gated (money / outside-Discord) calls
import { approvalsCapability } from '../tools/ops/approvals.js';
// Web capabilities
import { webCapability } from '../tools/core/web.js';
import { httpCapability } from '../tools/core/http.js';
import { mediaWikiCapability } from '../tools/web/mediawiki.js';
import { wolframCapability } from '../tools/web/wolfram.js';
import { n8nBrowserCapability } from '../tools/web/n8n-browser.js';
// Development capabilities. package_manager, system_installer and environment (.env
// read/write) ran on the production host with zero use; removed 2026-10-23.
import { filesystemCapability } from '../tools/dev/filesystem.js';
import { githubCapability } from '../tools/dev/github.js';
// sandbox = shell + edit + git + search(dev), all docker exec into the sandbox container
import { sandboxCapability } from '../tools/dev/sandbox.js';
// Memory capabilities
import { memoryCapability } from '../tools/core/memory.js';
// AI capabilities
import { visionCapability } from '../tools/media/vision.js';
import { imageGenCapability } from '../tools/media/image-gen.js';
// Productivity capabilities
// tasks = todo + quests + task-status (told apart by `tracker`)
import { tasksCapability } from '../tools/planning/tasks.js';
import { schedulerCapability } from '../tools/core/reminders.js';
import { scratchpadCapability } from '../tools/planning/scratchpad.js';
import { flashcardCapability } from '../tools/planning/flashcard.js';
import { quizGameCapability } from '../tools/planning/quiz-game.js';
import { morningBriefingCapability } from '../proactive/morning-briefing.js';
// goals absorbs the old `goal` tool (alias in registry.ts)
import { goalsCapability } from '../tools/planning/goals.js';
// Discord capabilities
import { discordUICapability } from '../tools/discord/ui.js';
import { discordForumsCapability } from '../tools/discord/forums.js';
import { discordModerationCapability } from '../tools/discord/moderation.js';
import { discordPollCapability } from '../tools/discord/poll.js';
import { discordReactionCapability } from '../tools/discord/reaction.js';
import { stripePaymentsCapability } from '../tools/money/stripe.js';
import { discordNicknameCapability } from '../tools/discord/nickname.js';
import { discordThreadsCapability } from '../tools/discord/threads.js';
import { discordSendMessageCapability } from '../tools/discord/send-message.js';
import { discordChannelsCapability } from '../tools/discord/channels.js';
import { discordUserHistoryCapability } from '../tools/discord/user-history.js';
import { discordIssueParserCapability } from '../tools/discord/issue-parser.js';
import { sendMetroFileCapability } from '../tools/discord/send-metro-file.js';
// Communication capabilities
import { askQuestionCapability } from '../tools/people/ask-question.js';
import { mentionProxyCapability } from '../tools/people/mention-proxy.js';
import { emailCapability } from '../tools/people/email.js';
import { redditCapability } from '../tools/personal/reddit.js';
import { proactiveDMCapability } from '../proactive/proactive-dm.js';
import { relayCapability } from '../proactive/relay.js';
// Analytics capabilities
import { selfStatsCapability } from '../tools/ops/self-stats.js';
import { communityAnalyticsCapability } from '../tools/ops/community-analytics.js';
// Media capabilities
import { ttsCapability } from '../tools/media/tts.js';
// Research capabilities
import { deepResearchCapability } from '../tools/research/deep-research.js';
import { trendWatcherCapability } from '../proactive/trend-watcher.js';
// Cross-agent capabilities
import { kanbanCapability } from '../tools/agents/kanban.js';
import { vpsClaudeCapability } from '../tools/agents/vps-claude.js';
import { hermesCapability } from '../tools/agents/hermes.js';
import { systemMemoryCapability } from '../tools/agents/system-memory.js';
import { osintLookupCapability } from '../tools/agents/osint-lookup.js';
// Services
import { meetingCapability } from '../tools/people/meeting.js';
// Formerly self-registered at registry.ts load (wave 7 moved them here)
import { embeddedMCPCapability } from '../tools/ops/embedded-mcp.js';
import { scrapbookCapability } from '../tools/personal/scrapbook.js';

// =====================================================
// CAPABILITY BOOTSTRAP SERVICE
// Handles initialization and registration of all capabilities
// =====================================================

export class CapabilityBootstrap {
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
        systemMonitorCapability, variableStoreCapability, tasksCapability,
        meetingCapability, discordUICapability, askQuestionCapability, discordForumsCapability,
        discordModerationCapability, mentionProxyCapability, emailCapability, proactiveDMCapability,
        userProfileCapability, pairingCapability, approvalsCapability, mediaWikiCapability, wolframCapability,
        schedulerCapability, sequenceCapability, sandboxCapability,
        scratchpadCapability, selfStatsCapability,
        communityAnalyticsCapability, contextCapability, visionCapability, imageGenCapability,
        diagnoseCapability, autonomousCapability, n8nBrowserCapability, flashcardCapability,
        quizGameCapability, redditCapability, deepResearchCapability,
        trendWatcherCapability, morningBriefingCapability,
        goalsCapability, kanbanCapability, vpsClaudeCapability, hermesCapability,
        systemMemoryCapability, osintLookupCapability, discordPollCapability,
        discordReactionCapability, stripePaymentsCapability, discordNicknameCapability,
        discordThreadsCapability, discordSendMessageCapability, discordChannelsCapability,
        discordUserHistoryCapability, discordIssueParserCapability, sendMetroFileCapability,
        relayCapability, ttsCapability,
      ];
      for (const capability of ALL_CAPABILITIES) {
        capabilityRegistry.register(capability);
      }

      // Initialize OpenClaw-compatible skill system (async, runs after main init)
      logger.info('🦞 Scheduling OpenClaw skill system initialization...');
      setImmediate(async () => {
        try {
          const { skillRegistry, skillsCapability } = await import('../tools/skills/registry.js');
          capabilityRegistry.register(skillsCapability);
          await skillRegistry.initialize();
          logger.info(`🦞 Skills system ready: ${skillRegistry.size()} skills loaded`);
        } catch (skillError) {
          logger.warn('⚠️ Skill system initialization failed (non-fatal):', skillError);
        }
      });

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

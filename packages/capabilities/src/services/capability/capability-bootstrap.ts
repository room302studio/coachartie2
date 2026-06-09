import { logger } from '@coachartie/shared';
import { capabilityRegistry } from './capability-registry.js';
// System capabilities
import { calculatorCapability } from '../../capabilities/system/calculator.js';
import { environmentCapability } from '../../capabilities/system/environment.js';
import { creditStatusCapability } from '../../capabilities/system/credit-status.js';
import { runtimeConfigCapability } from '../../capabilities/system/runtime-config.js';
import { systemMonitorCapability } from '../../capabilities/system/system-monitor.js';
import { variableStoreCapability } from '../../capabilities/system/variable-store.js';
import { sequenceCapability } from '../../capabilities/system/sequence.js';
import { contextCapability } from '../../capabilities/system/context.js';
import { diagnoseCapability } from '../../capabilities/system/diagnose.js';
import { userProfileCapability } from '../../capabilities/system/user-profile.js';
import { autonomousCapability } from '../../capabilities/system/autonomous.js';
import { pairingCapability } from '../../capabilities/system/pairing.js';
// Web capabilities
import { webCapability } from '../../capabilities/web/web.js';
import { httpCapability } from '../../capabilities/web/http.js';
import { mediaWikiCapability } from '../../capabilities/web/mediawiki.js';
import { wolframCapability } from '../../capabilities/web/wolfram.js';
import { searchCapability } from '../../capabilities/web/search.js';
import { n8nBrowserCapability } from '../../capabilities/web/n8n-browser.js';
// Development capabilities
import { packageManagerCapability } from '../../capabilities/development/package-manager.js';
import { filesystemCapability } from '../../capabilities/development/filesystem.js';
import { systemInstallerCapability } from '../../capabilities/development/system-installer.js';
import { githubCapability } from '../../capabilities/development/github.js';
import { shellCapability } from '../../capabilities/development/shell.js';
import { editCapability } from '../../capabilities/development/edit.js';
import { gitCapability } from '../../capabilities/development/git.js';
// Memory capabilities
import { memoryCapability } from '../../capabilities/memory/memory.js';
// AI capabilities
import { modelManagerCapability } from '../../capabilities/ai/model-manager.js';
import { visionCapability } from '../../capabilities/ai/vision.js';
import { imageGenCapability } from '../../capabilities/image-gen.js';
// Productivity capabilities
import { goalCapability } from '../../capabilities/productivity/goal.js';
import { todoCapability } from '../../capabilities/productivity/todo.js';
import { schedulerCapability } from '../../capabilities/productivity/scheduler.js';
import { scratchpadCapability } from '../../capabilities/productivity/scratchpad.js';
import { flashcardCapability } from '../../capabilities/productivity/flashcard.js';
import { quizGameCapability } from '../../capabilities/productivity/quiz-game.js';
import { questsCapability } from '../../capabilities/productivity/quests.js';
import { taskStatusCapability } from '../../capabilities/productivity/task-status.js';
import { morningBriefingCapability } from '../../capabilities/productivity/morning-briefing.js';
import { goalsCapability } from '../../capabilities/productivity/goals.js';
// Discord capabilities
import { discordUICapability } from '../../capabilities/discord/discord-ui.js';
import { discordForumsCapability } from '../../capabilities/discord/discord-forums.js';
import { discordModerationCapability } from '../../capabilities/discord/discord-moderation.js';
// Communication capabilities
import { askQuestionCapability } from '../../capabilities/communication/ask-question.js';
import { mentionProxyCapability } from '../../capabilities/communication/mention-proxy.js';
import { emailCapability } from '../../capabilities/communication/email.js';
import { redditCapability } from '../../capabilities/communication/reddit.js';
import { proactiveDMCapability } from '../../capabilities/communication/proactive-dm.js';
// Analytics capabilities
import { selfStatsCapability } from '../../capabilities/self-stats.js';
import { communityAnalyticsCapability } from '../../capabilities/community-analytics.js';
// Social capabilities
import { moltbookCapability } from '../../capabilities/social/moltbook.js';
// Research capabilities
import { deepResearchCapability } from '../../capabilities/research/deep-research.js';
import { trendWatcherCapability } from '../../capabilities/research/trend-watcher.js';
// Cross-agent capabilities
import { kanbanCapability } from '../../capabilities/system/kanban.js';
import { vpsClaudeCapability } from '../../capabilities/system/vps-claude.js';
import { hermesCapability } from '../../capabilities/system/hermes.js';
import { systemMemoryCapability } from '../../capabilities/system/system-memory.js';
import { osintLookupCapability } from '../../capabilities/system/osint-lookup.js';
// Services
import { meetingCapability } from '../core/meeting-service.js';

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
      // Register all capabilities (registration is idempotent, keyed by name)
      const ALL_CAPABILITIES = [
        calculatorCapability, webCapability, httpCapability, packageManagerCapability,
        filesystemCapability, environmentCapability, systemInstallerCapability, memoryCapability,
        githubCapability, creditStatusCapability, modelManagerCapability, runtimeConfigCapability,
        systemMonitorCapability, goalCapability, variableStoreCapability, todoCapability,
        meetingCapability, discordUICapability, askQuestionCapability, discordForumsCapability,
        discordModerationCapability, mentionProxyCapability, emailCapability, proactiveDMCapability,
        userProfileCapability, pairingCapability, mediaWikiCapability, wolframCapability,
        schedulerCapability, sequenceCapability, shellCapability, editCapability,
        searchCapability, gitCapability, scratchpadCapability, selfStatsCapability,
        communityAnalyticsCapability, contextCapability, visionCapability, imageGenCapability,
        diagnoseCapability, autonomousCapability, n8nBrowserCapability, flashcardCapability,
        quizGameCapability, redditCapability, moltbookCapability, deepResearchCapability,
        trendWatcherCapability, questsCapability, taskStatusCapability, morningBriefingCapability,
        goalsCapability, kanbanCapability, vpsClaudeCapability, hermesCapability,
        systemMemoryCapability, osintLookupCapability,
      ];
      for (const capability of ALL_CAPABILITIES) {
        capabilityRegistry.register(capability);
      }

      // Initialize OpenClaw-compatible skill system (async, runs after main init)
      logger.info('🦞 Scheduling OpenClaw skill system initialization...');
      setImmediate(async () => {
        try {
          const { skillRegistry, skillsCapability } = await import('../skills/skill-registry.js');
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

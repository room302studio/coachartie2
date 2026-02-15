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
// Discord capabilities
import { discordUICapability } from '../../capabilities/discord/discord-ui.js';
import { discordForumsCapability } from '../../capabilities/discord/discord-forums.js';
import { discordModerationCapability } from '../../capabilities/discord/discord-moderation.js';
// Slack capabilities
import { slackUICapability } from '../../capabilities/slack/slack-ui.js';
// Communication capabilities
import { askQuestionCapability } from '../../capabilities/communication/ask-question.js';
import { mentionProxyCapability } from '../../capabilities/communication/mention-proxy.js';
import { emailCapability } from '../../capabilities/communication/email.js';
import { redditCapability } from '../../capabilities/communication/reddit.js';
import { proactiveDMCapability } from '../../capabilities/communication/proactive-dm.js';
// Analytics capabilities
import { selfStatsCapability } from '../../capabilities/self-stats.js';
// Social capabilities
import { moltbookCapability } from '../../capabilities/social/moltbook.js';
// Research capabilities
import { deepResearchCapability } from '../../capabilities/research/deep-research.js';
import { trendWatcherCapability } from '../../capabilities/research/trend-watcher.js';
// Cross-agent capabilities
import { kanbanCapability } from '../../capabilities/system/kanban.js';
import { vpsClaudeCapability } from '../../capabilities/system/vps-claude.js';
import { systemMemoryCapability } from '../../capabilities/system/system-memory.js';
import { walletCapability } from '../../capabilities/system/wallet.js';
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
      // Register calculator capability from external file
      logger.info('📦 Registering calculator...');
      capabilityRegistry.register(calculatorCapability);

      // Register web capability from external file
      capabilityRegistry.register(webCapability);

      // Register HTTP capability - general purpose curl/fetch
      capabilityRegistry.register(httpCapability);

      // Register package manager capability from external file
      capabilityRegistry.register(packageManagerCapability);

      // Register filesystem capability from external file
      capabilityRegistry.register(filesystemCapability);

      // Register environment capability from external file
      capabilityRegistry.register(environmentCapability);

      // Register system installer capability for dependency management
      capabilityRegistry.register(systemInstallerCapability);

      // Register real memory capability with persistence
      capabilityRegistry.register(memoryCapability);

      // Register GitHub capability for deployment celebrations
      capabilityRegistry.register(githubCapability);

      // Register credit status capability for monitoring API usage
      capabilityRegistry.register(creditStatusCapability);

      // Register model manager capability for querying models and pricing
      capabilityRegistry.register(modelManagerCapability);

      // Register runtime config capability for dynamic adaptation
      capabilityRegistry.register(runtimeConfigCapability);

      // Register system monitor capability for resource monitoring
      capabilityRegistry.register(systemMonitorCapability);

      // Register goal capability
      capabilityRegistry.register(goalCapability);

      // Register variable store capability
      capabilityRegistry.register(variableStoreCapability);

      // Register todo capability
      capabilityRegistry.register(todoCapability);

      // Register meeting scheduler capability
      logger.info('📦 Registering meeting-scheduler...');
      capabilityRegistry.register(meetingCapability);
      logger.info('✅ meeting-scheduler registered successfully');

      // Register Discord UI capability for interactive components
      logger.info('📦 Registering discord-ui...');
      capabilityRegistry.register(discordUICapability);

      // Register Slack UI capability for interactive Block Kit components
      logger.info('📦 Registering slack-ui...');
      capabilityRegistry.register(slackUICapability);
      logger.info('✅ slack-ui registered successfully');

      // Register Ask Question capability - like Claude Code's AskUserQuestion tool
      logger.info('📦 Registering ask-question...');
      capabilityRegistry.register(askQuestionCapability);
      logger.info('✅ ask-question registered successfully');

      // Register Discord Forums capability for forum traversal and GitHub sync
      logger.info('📦 Registering discord-forums...');
      capabilityRegistry.register(discordForumsCapability);
      logger.info('✅ discord-forums registered successfully');

      // Register Discord Moderation capability for timeouts and role management
      logger.info('📦 Registering discord-moderation...');
      capabilityRegistry.register(discordModerationCapability);
      logger.info('✅ discord-moderation registered successfully');

      // Register Mention Proxy capability for user representation
      logger.info('📦 Registering mention-proxy...');
      capabilityRegistry.register(mentionProxyCapability);
      logger.info('✅ mention-proxy registered successfully');

      // Register Email capability for sending emails
      logger.info('📦 Registering email...');
      capabilityRegistry.register(emailCapability);
      logger.info('✅ email registered successfully');

      // Register Proactive DM capability - Clawdbot-style proactive messaging
      logger.info('📦 Registering proactive-dm (proactive messaging)...');
      capabilityRegistry.register(proactiveDMCapability);
      logger.info('✅ proactive-dm registered successfully');

      // Register User Profile capability for managing user metadata
      logger.info('📦 Registering user-profile...');
      capabilityRegistry.register(userProfileCapability);
      logger.info('✅ user-profile registered successfully');

      // Register Pairing capability for DM access control (OpenClaw-compatible)
      logger.info('📦 Registering pairing (DM access control)...');
      capabilityRegistry.register(pairingCapability);
      logger.info('✅ pairing registered successfully');

      // Register MediaWiki capability for editing multiple wikis
      logger.info('📦 Registering mediawiki...');
      capabilityRegistry.register(mediaWikiCapability);
      logger.info('✅ mediawiki registered successfully');

      // Register wolfram capability from external file
      capabilityRegistry.register(wolframCapability);

      // Register scheduler capability from external file
      capabilityRegistry.register(schedulerCapability);

      // Register sequence capability from external file
      capabilityRegistry.register(sequenceCapability);

      // Register shell capability - the laptop (terminal-native output)
      logger.info('📦 Registering shell (the laptop)...');
      capabilityRegistry.register(shellCapability);
      logger.info('✅ shell registered successfully');

      // Register edit capability - surgical file editing like Claude Code
      logger.info('📦 Registering edit (surgical editing)...');
      capabilityRegistry.register(editCapability);
      logger.info('✅ edit registered successfully');

      // Register search capability - fast file finding and content search
      logger.info('📦 Registering search (glob + grep)...');
      capabilityRegistry.register(searchCapability);
      logger.info('✅ search registered successfully');

      // Register git capability - version control awareness
      logger.info('📦 Registering git (version control)...');
      capabilityRegistry.register(gitCapability);
      logger.info('✅ git registered successfully');

      // Register scratchpad capability - externalized thinking
      logger.info('📦 Registering scratchpad (thinking space)...');
      capabilityRegistry.register(scratchpadCapability);
      logger.info('✅ scratchpad registered successfully');

      // Register self-stats capability - introspection
      logger.info('📦 Registering self-stats (introspection)...');
      capabilityRegistry.register(selfStatsCapability);
      logger.info('✅ self-stats registered successfully');

      // Register context capability - situational awareness
      logger.info('📦 Registering context (situational awareness)...');
      capabilityRegistry.register(contextCapability);
      logger.info('✅ context registered successfully');

      // Register vision capability - image/text extraction helper
      logger.info('📦 Registering vision (image/text extraction helper)...');
      capabilityRegistry.register(visionCapability);
      logger.info('✅ vision registered successfully');

      // Register image generation capability - Nano Banana (Gemini) image generation
      logger.info('📦 Registering image_gen (Nano Banana image generation)...');
      capabilityRegistry.register(imageGenCapability);
      logger.info('✅ image_gen registered successfully');

      // Register diagnose capability - understand what went wrong
      logger.info('📦 Registering diagnose (error analysis)...');
      capabilityRegistry.register(diagnoseCapability);
      logger.info('✅ diagnose registered successfully');

      // Register autonomous capability - n8nClaw-style proactive behaviors
      logger.info('📦 Registering autonomous (proactive behaviors)...');
      capabilityRegistry.register(autonomousCapability);
      logger.info('✅ autonomous registered successfully');

      // Register n8n browser capability - fetch web pages via n8n
      logger.info('📦 Registering n8n-browser (web fetching)...');
      capabilityRegistry.register(n8nBrowserCapability);
      logger.info('✅ n8n-browser registered successfully');

      // Register flashcard capability - quiz and study with flashcards
      logger.info('📦 Registering flashcard (quiz/study)...');
      capabilityRegistry.register(flashcardCapability);
      logger.info('✅ flashcard registered successfully');

      // Register quiz-game capability - channel-wide quiz competitions
      logger.info('📦 Registering quiz-game (multiplayer quizzes)...');
      capabilityRegistry.register(quizGameCapability);
      logger.info('✅ quiz-game registered successfully');

      // Register reddit capability - read/write to Reddit
      logger.info('📦 Registering reddit...');
      capabilityRegistry.register(redditCapability);
      logger.info('✅ reddit registered successfully');

      // Register moltbook capability - AI-only social network
      logger.info('📦 Registering moltbook (AI social network)...');
      capabilityRegistry.register(moltbookCapability);
      logger.info('✅ moltbook registered successfully');

      // Register deep research capability - o4-mini-deep-research harness
      logger.info('📦 Registering deep_research (o4-mini background research)...');
      capabilityRegistry.register(deepResearchCapability);
      logger.info('✅ deep_research registered successfully');

      // Register trend watcher capability - monitor GitHub trending and HN
      logger.info('📦 Registering trend-watcher (tech trends monitoring)...');
      capabilityRegistry.register(trendWatcherCapability);
      logger.info('✅ trend-watcher registered successfully');

      // Register quests capability - multi-step workflow guidance
      logger.info('📦 Registering quests (workflow guidance)...');
      capabilityRegistry.register(questsCapability);
      logger.info('✅ quests registered successfully');

      // Register task status capability - progress updates for long operations
      logger.info('📦 Registering task-status (progress tracking)...');
      capabilityRegistry.register(taskStatusCapability);
      logger.info('✅ task-status registered successfully');

      // Register morning briefing capability - Clawdbot-style daily intelligence
      logger.info('📦 Registering morning-briefing (daily digest)...');
      capabilityRegistry.register(morningBriefingCapability);
      logger.info('✅ morning-briefing registered successfully');

      // Register cross-agent capabilities - weave VPS Claude and Artie together
      logger.info('📦 Registering kanban (shared task board)...');
      capabilityRegistry.register(kanbanCapability);
      logger.info('✅ kanban registered successfully');

      logger.info('📦 Registering vps_claude (cross-agent awareness)...');
      capabilityRegistry.register(vpsClaudeCapability);
      logger.info('✅ vps_claude registered successfully');

      logger.info('📦 Registering system_memory (cross-agent communication)...');
      capabilityRegistry.register(systemMemoryCapability);
      logger.info('✅ system_memory registered successfully');

      logger.info('📦 Registering wallet (crypto autonomy)...');
      capabilityRegistry.register(walletCapability);
      logger.info('✅ wallet registered successfully');

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

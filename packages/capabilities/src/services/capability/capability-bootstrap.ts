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
// Productivity capabilities
import { goalCapability } from '../../capabilities/productivity/goal.js';
import { todoCapability } from '../../capabilities/productivity/todo.js';
import { schedulerCapability } from '../../capabilities/productivity/scheduler.js';
import { scratchpadCapability } from '../../capabilities/productivity/scratchpad.js';
import { flashcardCapability } from '../../capabilities/productivity/flashcard.js';
import { quizGameCapability } from '../../capabilities/productivity/quiz-game.js';
// Discord capabilities
import { discordUICapability } from '../../capabilities/discord/discord-ui.js';
import { discordForumsCapability } from '../../capabilities/discord/discord-forums.js';
// Slack capabilities
import { slackUICapability } from '../../capabilities/slack/slack-ui.js';
// Communication capabilities
import { askQuestionCapability } from '../../capabilities/communication/ask-question.js';
import { mentionProxyCapability } from '../../capabilities/communication/mention-proxy.js';
import { emailCapability } from '../../capabilities/communication/email.js';
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

      // Register Mention Proxy capability for user representation
      logger.info('📦 Registering mention-proxy...');
      capabilityRegistry.register(mentionProxyCapability);
      logger.info('✅ mention-proxy registered successfully');

      // Register Email capability for sending emails
      logger.info('📦 Registering email...');
      capabilityRegistry.register(emailCapability);
      logger.info('✅ email registered successfully');

      // Register User Profile capability for managing user metadata
      logger.info('📦 Registering user-profile...');
      capabilityRegistry.register(userProfileCapability);
      logger.info('✅ user-profile registered successfully');

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

      // Register context capability - situational awareness
      logger.info('📦 Registering context (situational awareness)...');
      capabilityRegistry.register(contextCapability);
      logger.info('✅ context registered successfully');

      // Register vision capability - image/text extraction helper
      logger.info('📦 Registering vision (image/text extraction helper)...');
      capabilityRegistry.register(visionCapability);
      logger.info('✅ vision registered successfully');

      // Register diagnose capability - understand what went wrong
      logger.info('📦 Registering diagnose (error analysis)...');
      capabilityRegistry.register(diagnoseCapability);
      logger.info('✅ diagnose registered successfully');

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

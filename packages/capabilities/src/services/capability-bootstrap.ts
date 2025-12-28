import { logger } from '@coachartie/shared';
import { capabilityRegistry } from './capability-registry.js';
import { calculatorCapability } from '../capabilities/calculator.js';
import { webCapability } from '../capabilities/web.js';
import { httpCapability } from '../capabilities/http.js';
import { packageManagerCapability } from '../capabilities/package-manager.js';
import { filesystemCapability } from '../capabilities/filesystem.js';
import { environmentCapability } from '../capabilities/environment.js';
import { systemInstallerCapability } from '../capabilities/system-installer.js';
import { memoryCapability } from '../capabilities/memory.js';
import { githubCapability } from '../capabilities/github.js';
import { creditStatusCapability } from '../capabilities/credit-status.js';
import { modelManagerCapability } from '../capabilities/model-manager.js';
import { runtimeConfigCapability } from '../capabilities/runtime-config.js';
import { systemMonitorCapability } from '../capabilities/system-monitor.js';
import { goalCapability } from '../capabilities/goal.js';
import { variableStoreCapability } from '../capabilities/variable-store.js';
import { todoCapability } from '../capabilities/todo.js';
import { discordUICapability } from '../capabilities/discord-ui.js';
import { slackUICapability } from '../capabilities/slack-ui.js';
import { askQuestionCapability } from '../capabilities/ask-question.js';
import { discordForumsCapability } from '../capabilities/discord-forums.js';
import { mentionProxyCapability } from '../capabilities/mention-proxy.js';
import { emailCapability } from '../capabilities/email.js';
import { userProfileCapability } from '../capabilities/user-profile.js';
import { mediaWikiCapability } from '../capabilities/mediawiki.js';
import { wolframCapability } from '../capabilities/wolfram.js';
import { schedulerCapability } from '../capabilities/scheduler.js';
import { sequenceCapability } from '../capabilities/sequence.js';
import { shellCapability } from '../capabilities/shell.js';
import { editCapability } from '../capabilities/edit.js';
import { searchCapability } from '../capabilities/search.js';
import { gitCapability } from '../capabilities/git.js';
import { scratchpadCapability } from '../capabilities/scratchpad.js';
import { contextCapability } from '../capabilities/context.js';
import { diagnoseCapability } from '../capabilities/diagnose.js';
import { visionCapability } from '../capabilities/vision.js';
import { meetingCapability } from './meeting-service.js';
import { n8nBrowserCapability } from '../capabilities/n8n-browser.js';
import { flashcardCapability } from '../capabilities/flashcard.js';
import { quizGameCapability } from '../capabilities/quiz-game.js';

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

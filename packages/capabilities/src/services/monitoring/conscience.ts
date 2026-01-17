import { openRouterService } from '../llm/openrouter.js';
import { logger, getSyncDb } from '@coachartie/shared';

export interface CapabilityRequest {
  name: string;
  action: string;
  params: Record<string, unknown>;
}

interface SafetyManifestCapability {
  dangerousActions: string[];
  warnings: Record<string, string>;
  blacklistedPaths?: string[];
  blacklistedCommands?: string[];
  sqlInjectionPatterns?: string[];
}

export class ConscienceLLM {
  private conscienceModel = 'microsoft/phi-3-mini-128k-instruct:free';

  /**
   * Generate a quick goal-aware whisper for the main LLM
   * This provides contextual awareness without being heavy-handed
   */
  async getGoalWhisper(userMessage: string, userId: string): Promise<string> {
    if (!process.env.ENABLE_CONSCIENCE || process.env.ENABLE_CONSCIENCE === 'false') {
      return '';
    }

    try {
      const timeoutMs = parseInt(process.env.CONSCIENCE_TIMEOUT_MS || '200');

      // Race against timeout
      const whisperPromise = this.generateWhisper(userMessage, userId);
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve(''), timeoutMs)
      );

      const whisper = await Promise.race([whisperPromise, timeoutPromise]);

      if (whisper) {
        logger.debug(`🧠 Conscience whisper: "${whisper}"`);
      }

      return whisper;
    } catch (error) {
      logger.warn('Conscience whisper failed, continuing without context:', error);
      return '';
    }
  }

  private async generateWhisper(userMessage: string, userId: string): Promise<string> {
    // Get context quickly
    const context = await this.getQuickContext(userId);

    const prompt = `Active goals: ${context.goals}
Recent activity: ${context.recentTopics}
Current time: ${new Date().toLocaleTimeString()}
User energy: ${this.inferEnergyLevel(userMessage)}

User just said: "${userMessage}"

In ONE sentence, what should I keep in mind when responding? Focus on emotional context, energy levels, deadline pressure, or goal relevance. Be subtle and supportive.

Examples:
- "They have a deadline in 30 minutes but seem stressed - encourage a quick break"
- "No active goals set, good opportunity to help them plan"
- "They're in deep work mode, be concise and helpful"`;

    try {
      const { contextAlchemy } = await import('../llm/context-alchemy.js');
      const { promptManager } = await import('../llm/prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      const { messages } = await contextAlchemy.buildMessageChain(prompt, userId, baseSystemPrompt);

      const response = await openRouterService.generateFromMessageChain(messages, userId);
      return response.trim();
    } catch (error) {
      logger.warn('Whisper generation failed:', error);
      return '';
    }
  }

  private async getQuickContext(userId: string): Promise<{ goals: string; recentTopics: string }> {
    try {
      const db = getSyncDb();

      // Get active goals
      const goals = db.all(
        'SELECT objective, deadline FROM goals WHERE user_id = ? AND status != "completed" ORDER BY priority DESC LIMIT 3',
        [userId]
      );

      // Get recent conversation topics
      const recentMemories = db.all(
        'SELECT content FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userId]
      );

      return {
        goals:
          goals.length > 0
            ? goals
                .map(
                  (g) =>
                    g.objective +
                    (g.deadline ? ` (due: ${new Date(g.deadline).toLocaleDateString()})` : '')
                )
                .join(', ')
            : 'No active goals',
        recentTopics:
          recentMemories.length > 0
            ? recentMemories.map((m) => m.content.substring(0, 50)).join(', ')
            : 'No recent activity',
      };
    } catch (error) {
      logger.warn('Failed to get context for whisper:', error);
      return { goals: 'Unknown', recentTopics: 'Unknown' };
    }
  }

  private inferEnergyLevel(message: string): string {
    const lower = message.toLowerCase();

    if (lower.includes('tired') || lower.includes('exhausted') || lower.includes('burned out')) {
      return 'low';
    }
    if (lower.includes('excited') || lower.includes('pumped') || lower.includes('love')) {
      return 'high';
    }
    if (lower.includes('frustrated') || lower.includes('stuck') || lower.includes('confused')) {
      return 'frustrated';
    }

    return 'neutral';
  }

  // Get conscience prompt from database
  private async getConsciencePrompt(): Promise<string> {
    try {
      const { promptManager } = await import('../llm/prompt-manager.js');
      const prompt = await promptManager.getPrompt('PROMPT_CONSCIENCE_SYSTEM');
      if (prompt?.content) {
        return prompt.content;
      }
    } catch (error) {
      logger.warn('Failed to load conscience prompt from database, using fallback', error);
    }

    // Fallback prompt if database fails
    return `🚨 CRITICAL SAFETY EVALUATION REQUIRED 🚨
You are a security expert in a DEVELOPMENT ENVIRONMENT. Allow legitimate development work while blocking actual system damage.

ALWAYS ALLOW: memory, calculator, web, mcp_installer, mcp_client, package_manager (in project dirs), GitHub cloning to user dirs
ALWAYS BLOCK: System file deletion (/etc/, /usr/, /var/), destructive shell commands (rm -rf, dd, mkfs)

For SAFE operations: "APPROVED: [operation] is allowed for development"
For DANGEROUS operations: Explain why unsafe, no approval`;
  }

  // Safety manifest for capabilities
  private readonly SAFETY_MANIFEST: Record<string, SafetyManifestCapability> = {
    filesystem: {
      dangerousActions: ['delete', 'write_file'],
      warnings: {
        delete:
          'CRITICAL: Filesystem deletion can be IRREVERSIBLE. System files must NEVER be deleted.',
        write_file: 'WARNING: Writing files can overwrite important data. Verify paths carefully.',
      },
      blacklistedPaths: ['/etc/', '/usr/', '/var/', '/System/', '/boot/', '/root/'],
    },
    shell: {
      dangerousActions: ['execute'],
      warnings: {
        execute:
          'EXTREME DANGER: Shell execution can compromise entire system. Block destructive commands.',
      },
      blacklistedCommands: ['rm -rf', 'dd', 'mkfs', 'fdisk', 'format', 'del /s', 'sudo'],
    },
    memory: {
      dangerousActions: [],
      warnings: {},
      sqlInjectionPatterns: ['DROP TABLE', 'DELETE FROM', 'UPDATE SET', '; --', 'UNION SELECT'],
    },
  };

  private checkBlacklist(capability: CapabilityRequest): string[] {
    const warnings: string[] = [];
    const manifest = this.SAFETY_MANIFEST[capability.name];

    if (!manifest) {
      return warnings;
    }

    // Check for dangerous actions
    if (manifest.dangerousActions?.includes(capability.action)) {
      const warning = manifest.warnings[capability.action];
      if (warning) {
        warnings.push(`⚠️ ${warning}`);
      }
    }

    // Check filesystem paths - be more precise about dangerous paths
    if (capability.name === 'filesystem' && capability.action === 'delete' && capability.params) {
      const path =
        typeof capability.params === 'string' ? capability.params : capability.params.path;
      if (
        path &&
        typeof path === 'string' &&
        manifest.blacklistedPaths?.some((blocked: string) => path.includes(blocked))
      ) {
        warnings.push(
          '🚨 BLACKLISTED PATH: This targets system directories that must never be modified!'
        );
      }
    }

    // Check shell commands
    if (capability.name === 'shell' && capability.params) {
      const command =
        typeof capability.params === 'string' ? capability.params : capability.params.command;
      if (
        command &&
        typeof command === 'string' &&
        manifest.blacklistedCommands?.some((blocked: string) => command.includes(blocked))
      ) {
        warnings.push('🚨 BLACKLISTED COMMAND: This shell command is known to be destructive!');
      }
    }

    // Check SQL injection patterns
    if (capability.name === 'memory' && capability.params) {
      const content =
        typeof capability.params === 'string'
          ? capability.params
          : JSON.stringify(capability.params);
      if (
        manifest.sqlInjectionPatterns?.some((pattern: string) =>
          content.toUpperCase().includes(pattern)
        )
      ) {
        warnings.push('🚨 SQL INJECTION DETECTED: This content contains dangerous SQL patterns!');
      }
    }

    return warnings;
  }

  async review(userMessage: string, capability: CapabilityRequest): Promise<string> {
    try {
      logger.info(
        `🔍 CONSCIENCE REVIEW: Checking capability ${capability.name}:${capability.action} with params: ${JSON.stringify(capability.params)}`
      );
      // Immediate failsafe: Block dangerous filesystem operations without LLM
      if (capability.name === 'filesystem' && capability.action === 'delete') {
        const path =
          typeof capability.params === 'string' ? capability.params : capability.params?.path || '';
        const dangerousPaths = [
          '/etc/',
          '/usr/',
          '/var/',
          '/System/',
          '/boot/',
          '/root/',
          'passwd',
          'shadow',
          'hosts',
        ];

        if (
          typeof path === 'string' &&
          dangerousPaths.some((dangerous) => path.includes(dangerous))
        ) {
          logger.info(`🚨 IMMEDIATE BLOCK: Dangerous filesystem path detected: ${path}`);
          return 'BLOCKED: Critical system file access denied. This operation targets protected system files and cannot be executed.';
        }
      }

      // Immediate failsafe: Block dangerous shell commands without LLM
      if (capability.name === 'shell' && capability.action === 'execute') {
        const command =
          typeof capability.params === 'string'
            ? capability.params
            : capability.params?.command || '';
        const dangerousCommands = ['rm -rf', 'dd', 'mkfs', 'fdisk', 'format', 'del /s'];

        if (
          typeof command === 'string' &&
          dangerousCommands.some((dangerous) => command.includes(dangerous))
        ) {
          logger.info(`🚨 IMMEDIATE BLOCK: Dangerous shell command detected: ${command}`);
          return 'BLOCKED: Destructive command access denied. This operation could cause irreversible system damage.';
        }
      }

      // Allow safe operations immediately without LLM review
      if (
        capability.name === 'memory' ||
        capability.name === 'calculator' ||
        capability.name === 'web' ||
        capability.name === 'wolfram' ||
        capability.name === 'briefing' ||
        capability.name === 'scheduler' ||
        capability.name === 'mcp_client' ||
        capability.name === 'mcp_installer' ||
        capability.name === 'goal' ||
        capability.name === 'variable' ||
        capability.name === 'todo' ||
        capability.name === 'discord-ui' ||
        capability.name === 'github'
      ) {
        logger.info(`✅ IMMEDIATE ALLOW: Safe operation ${capability.name}:${capability.action}`);

        // Just return approval text - DON'T regenerate XML!
        return `APPROVED: Safe operation ${capability.name}:${capability.action} is allowed.`;
      }

      logger.info(
        `🤔 CONSCIENCE: ${capability.name} not in safe operations list, proceeding with LLM review`
      );

      // Get dynamic safety warnings
      const blacklistWarnings = this.checkBlacklist(capability);
      const warningsText =
        blacklistWarnings.length > 0
          ? `\n🚨 SECURITY ALERTS:\n${blacklistWarnings.join('\n')}\n`
          : '';

      // Get capability-specific guidance
      const manifest = this.SAFETY_MANIFEST[capability.name];
      const capabilityGuidance = manifest?.dangerousActions?.includes(capability.action)
        ? `\n⚡ HIGH-RISK CAPABILITY: ${capability.name}:${capability.action} requires extra scrutiny!\n`
        : '';

      // Get prompt from database with parameter substitution
      const basePrompt = await this.getConsciencePrompt();
      const prompt =
        basePrompt
          .replace('{{USER_MESSAGE}}', userMessage)
          .replace('{{CAPABILITY_NAME}}', capability.name)
          .replace('{{CAPABILITY_ACTION}}', capability.action)
          .replace('{{CAPABILITY_PARAMS}}', JSON.stringify(capability.params)) +
        `\n\n${warningsText}${capabilityGuidance}`;

      const { contextAlchemy } = await import('../llm/context-alchemy.js');
      const { promptManager } = await import('../llm/prompt-manager.js');

      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      const { messages } = await contextAlchemy.buildMessageChain(
        prompt,
        'conscience-system',
        baseSystemPrompt
      );

      const response = await openRouterService.generateFromMessageChain(
        messages,
        'conscience-system'
      );

      logger.info(
        `Conscience reviewed ${capability.name}:${capability.action} - response length: ${response.length}`
      );

      return response;
    } catch (error) {
      logger.error('Conscience LLM error:', error);

      // Fail safe: block the operation if conscience can't evaluate
      return `I'm having trouble evaluating this operation for safety. To be cautious, I'll hold off on executing ${capability.name}:${capability.action}. Could you try rephrasing what you'd like to accomplish?`;
    }
  }
}

// Export singleton instance
export const conscienceLLM = new ConscienceLLM();

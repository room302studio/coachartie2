import { openRouterService } from './openrouter.js';
import { logger } from '@coachartie/shared';

export interface CapabilityRequest {
  name: string;
  action: string;
  params: any;
}

interface SafetyManifestCapability {
  dangerousActions: string[];
  warnings: Record<string, string>;
  blacklistedPaths?: string[];
  blacklistedCommands?: string[];
  sqlInjectionPatterns?: string[];
}

export class ConscienceLLM {
  // Safety manifest for capabilities
  private readonly SAFETY_MANIFEST: Record<string, SafetyManifestCapability> = {
    filesystem: {
      dangerousActions: ['delete', 'write_file'],
      warnings: {
        delete: 'CRITICAL: Filesystem deletion can be IRREVERSIBLE. System files must NEVER be deleted.',
        write_file: 'WARNING: Writing files can overwrite important data. Verify paths carefully.'
      },
      blacklistedPaths: ['/etc/', '/usr/', '/var/', '/System/', '/boot/', '/root/']
    },
    shell: {
      dangerousActions: ['execute'],
      warnings: {
        execute: 'EXTREME DANGER: Shell execution can compromise entire system. Block destructive commands.'
      },
      blacklistedCommands: ['rm -rf', 'dd', 'mkfs', 'fdisk', 'format', 'del /s', 'sudo']
    },
    memory: {
      dangerousActions: [],
      warnings: {},
      sqlInjectionPatterns: ['DROP TABLE', 'DELETE FROM', 'UPDATE SET', '; --', 'UNION SELECT']
    }
  };

  private checkBlacklist(capability: CapabilityRequest): string[] {
    const warnings: string[] = [];
    const manifest = this.SAFETY_MANIFEST[capability.name];
    
    if (!manifest) return warnings;

    // Check for dangerous actions
    if (manifest.dangerousActions?.includes(capability.action)) {
      const warning = manifest.warnings[capability.action];
      if (warning) warnings.push(`⚠️ ${warning}`);
    }

    // Check filesystem paths - be more precise about dangerous paths
    if (capability.name === 'filesystem' && capability.action === 'delete' && capability.params) {
      const path = typeof capability.params === 'string' ? capability.params : capability.params.path;
      if (path && manifest.blacklistedPaths?.some((blocked: string) => path.includes(blocked))) {
        warnings.push('🚨 BLACKLISTED PATH: This targets system directories that must never be modified!');
      }
    }

    // Check shell commands
    if (capability.name === 'shell' && capability.params) {
      const command = typeof capability.params === 'string' ? capability.params : capability.params.command;
      if (command && manifest.blacklistedCommands?.some((blocked: string) => command.includes(blocked))) {
        warnings.push('🚨 BLACKLISTED COMMAND: This shell command is known to be destructive!');
      }
    }

    // Check SQL injection patterns
    if (capability.name === 'memory' && capability.params) {
      const content = typeof capability.params === 'string' ? capability.params : JSON.stringify(capability.params);
      if (manifest.sqlInjectionPatterns?.some((pattern: string) => content.toUpperCase().includes(pattern))) {
        warnings.push('🚨 SQL INJECTION DETECTED: This content contains dangerous SQL patterns!');
      }
    }

    return warnings;
  }

  async review(userMessage: string, capability: CapabilityRequest): Promise<string> {
    try {
      // Immediate failsafe: Block dangerous filesystem operations without LLM
      if (capability.name === 'filesystem' && capability.action === 'delete') {
        const path = typeof capability.params === 'string' ? capability.params : capability.params?.path || '';
        const dangerousPaths = ['/etc/', '/usr/', '/var/', '/System/', '/boot/', '/root/', 'passwd', 'shadow', 'hosts'];
        
        if (dangerousPaths.some(dangerous => path.includes(dangerous))) {
          logger.info(`🚨 IMMEDIATE BLOCK: Dangerous filesystem path detected: ${path}`);
          return 'BLOCKED: Critical system file access denied. This operation targets protected system files and cannot be executed.';
        }
      }

      // Immediate failsafe: Block dangerous shell commands without LLM
      if (capability.name === 'shell' && capability.action === 'execute') {
        const command = typeof capability.params === 'string' ? capability.params : capability.params?.command || '';
        const dangerousCommands = ['rm -rf', 'dd', 'mkfs', 'fdisk', 'format', 'del /s'];
        
        if (dangerousCommands.some(dangerous => command.includes(dangerous))) {
          logger.info(`🚨 IMMEDIATE BLOCK: Dangerous shell command detected: ${command}`);
          return 'BLOCKED: Destructive command access denied. This operation could cause irreversible system damage.';
        }
      }

      // Allow safe operations immediately without LLM review
      if (capability.name === 'memory' || capability.name === 'calculator' || capability.name === 'web' || 
          capability.name === 'deployment_cheerleader' || capability.name === 'github') {
        logger.info(`✅ IMMEDIATE ALLOW: Safe operation ${capability.name}:${capability.action}`);
        
        if (capability.params && typeof capability.params === 'object' && Object.keys(capability.params).length > 0) {
          return `<capability name="${capability.name}" action="${capability.action}">${JSON.stringify(capability.params)}</capability>`;
        } else if (capability.params && typeof capability.params === 'string') {
          return `<capability name="${capability.name}" action="${capability.action}">${capability.params}</capability>`;
        } else {
          return `<capability name="${capability.name}" action="${capability.action}" />`;
        }
      }

      // Get dynamic safety warnings
      const blacklistWarnings = this.checkBlacklist(capability);
      const warningsText = blacklistWarnings.length > 0 
        ? `\n🚨 SECURITY ALERTS:\n${blacklistWarnings.join('\n')}\n` 
        : '';

      // Get capability-specific guidance
      const manifest = this.SAFETY_MANIFEST[capability.name];
      const capabilityGuidance = manifest?.dangerousActions?.includes(capability.action)
        ? `\n⚡ HIGH-RISK CAPABILITY: ${capability.name}:${capability.action} requires extra scrutiny!\n`
        : '';

      const prompt = `
🚨 CRITICAL SAFETY EVALUATION REQUIRED 🚨
${warningsText}${capabilityGuidance}
You are a security expert reviewing a potentially dangerous operation. Your job is to PROTECT the system from harm.

OPERATION TO REVIEW:
User request: "${userMessage}"
System wants to execute: ${capability.name}.${capability.action}(${JSON.stringify(capability.params)})

🔴 DANGEROUS OPERATIONS - ALWAYS BLOCK:
- filesystem:delete with system paths (/etc/, /usr/, /var/, /System/, passwd, shadow, hosts)
- shell:execute with destructive commands (rm -rf, dd, mkfs, fdisk)
- SQL injection patterns (DROP TABLE, DELETE FROM, UPDATE SET)
- Writing to system configuration files

✅ SAFE OPERATIONS - ALWAYS ALLOW:
- memory:search, memory:remember, memory:recall (always safe)
- calculator:calculate, calculator:eval (always safe)
- web:search, web:fetch (always safe)
- filesystem:read_file, filesystem:list_directory (always safe)
- Reading user files in home directories

RESPONSE RULES:
1. For SAFE operations: Include the original <capability> tag exactly as requested
2. For DANGEROUS operations: Explain why it's unsafe, NO <capability> tags EVER
3. For filesystem:delete: Only allow if deleting user files, NOT system files

EXAMPLE SAFE RESPONSE:
<capability name="memory" action="search">pizza preferences</capability>

EXAMPLE DANGEROUS RESPONSE:
This operation targets /etc/passwd which is a critical system file. I cannot allow this operation.

CRITICAL: If you detect /etc/, /usr/, /var/, /System/, passwd, shadow, or hosts in the operation, respond with "BLOCKED: Critical system file access denied" and NO capability tags.

Remember: It's better to be overly cautious than to cause irreversible damage. System security is your top priority.
      `;

      const response = await openRouterService.generateResponse(prompt, 'conscience-system');
      
      logger.info(`Conscience reviewed ${capability.name}:${capability.action} - response length: ${response.length}`);
      
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
/**
 * Skill Registry
 *
 * Manages OpenClaw-compatible skills and integrates them with
 * Coach Artie's capability system.
 *
 * Features:
 * - Auto-discovery of skills from filesystem
 * - Hot-reload capability for development
 * - Skill installation from ClawHub (future)
 * - Skill version tracking
 */

import { logger } from '@coachartie/shared';
import { discoverSkills, loadSkill, getSkillPaths } from './skill-loader.js';
import { capabilityRegistry } from '../capability/capability-registry.js';
import type { RegisteredCapability } from '../capability/capability-registry.js';

interface SkillMetadata {
  name: string;
  source: 'filesystem' | 'clawhub' | 'bundled';
  path?: string;
  version?: string;
  loadedAt: Date;
  enabled: boolean;
}

class SkillRegistry {
  private skills = new Map<string, SkillMetadata>();
  private initialized = false;

  /**
   * Initialize the skill registry and load all discovered skills
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    logger.info('🦞 Initializing OpenClaw skill registry...');

    const discoveredSkills = discoverSkills();
    let registered = 0;

    for (const [name, capability] of discoveredSkills) {
      try {
        // Register with the main capability registry
        capabilityRegistry.register(capability);

        // Track skill metadata
        this.skills.set(name, {
          name,
          source: 'filesystem',
          loadedAt: new Date(),
          enabled: true,
        });

        registered++;
      } catch (error) {
        logger.warn(`Failed to register skill '${name}':`, error);
      }
    }

    logger.info(`🦞 Skill registry initialized: ${registered} skills loaded`);
    logger.info(`🦞 Skill paths: ${getSkillPaths().join(', ') || 'none found'}`);

    this.initialized = true;
  }

  /**
   * Get all loaded skills
   */
  list(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get a specific skill's metadata
   */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /**
   * Enable a skill
   */
  enable(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = true;
      return true;
    }
    return false;
  }

  /**
   * Disable a skill
   */
  disable(name: string): boolean {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = false;
      return true;
    }
    return false;
  }

  /**
   * Reload a specific skill
   */
  reload(name: string): boolean {
    const capability = loadSkill(name);
    if (capability) {
      try {
        capabilityRegistry.register(capability);
        this.skills.set(name, {
          name,
          source: 'filesystem',
          loadedAt: new Date(),
          enabled: true,
        });
        logger.info(`🦞 Reloaded skill: ${name}`);
        return true;
      } catch (error) {
        logger.error(`Failed to reload skill '${name}':`, error);
      }
    }
    return false;
  }

  /**
   * Reload all skills
   */
  async reloadAll(): Promise<number> {
    this.initialized = false;
    this.skills.clear();
    await this.initialize();
    return this.skills.size;
  }

  /**
   * Check if skill registry is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Get skill count
   */
  size(): number {
    return this.skills.size;
  }
}

// Singleton instance
export const skillRegistry = new SkillRegistry();

/**
 * Skill management capability
 * Allows users to list, enable, disable, and reload skills
 */
export const skillsCapability: RegisteredCapability = {
  name: 'skills',
  emoji: '🦞',
  supportedActions: ['list', 'info', 'enable', 'disable', 'reload', 'paths'],
  description: `Manage OpenClaw-compatible skills. Actions:
- list: Show all loaded skills
- info [name]: Get details about a specific skill
- enable [name]: Enable a disabled skill
- disable [name]: Disable a skill
- reload [name]: Reload a skill from disk
- paths: Show skill loading paths`,
  handler: async (params, content, ctx) => {
    const { action } = params;
    const skillName = params.name || params.skill || content;

    switch (action) {
      case 'list': {
        const skills = skillRegistry.list();
        if (skills.length === 0) {
          return 'No skills loaded. Add SKILL.md files to your skills directory.';
        }
        const list = skills.map(s =>
          `- **${s.name}** (${s.source}) ${s.enabled ? '✅' : '❌'}`
        ).join('\n');
        return `**Loaded Skills (${skills.length})**\n\n${list}`;
      }

      case 'info': {
        if (!skillName) {
          return 'Please specify a skill name.';
        }
        const skill = skillRegistry.get(skillName);
        if (!skill) {
          return `Skill '${skillName}' not found.`;
        }
        const capabilities = capabilityRegistry.list();
        const capability = capabilities.find(c => c.name === skillName);
        return `**${skill.name}**
Source: ${skill.source}
Enabled: ${skill.enabled ? 'Yes' : 'No'}
Loaded: ${skill.loadedAt.toISOString()}
Actions: ${capability?.supportedActions.join(', ') || 'unknown'}

${capability?.description || 'No description available.'}`;
      }

      case 'enable': {
        if (!skillName) {
          return 'Please specify a skill name.';
        }
        const success = skillRegistry.enable(skillName);
        return success ? `Skill '${skillName}' enabled.` : `Skill '${skillName}' not found.`;
      }

      case 'disable': {
        if (!skillName) {
          return 'Please specify a skill name.';
        }
        const success = skillRegistry.disable(skillName);
        return success ? `Skill '${skillName}' disabled.` : `Skill '${skillName}' not found.`;
      }

      case 'reload': {
        if (skillName) {
          const success = skillRegistry.reload(skillName);
          return success ? `Skill '${skillName}' reloaded.` : `Failed to reload skill '${skillName}'.`;
        } else {
          const count = await skillRegistry.reloadAll();
          return `Reloaded ${count} skills.`;
        }
      }

      case 'paths': {
        const paths = getSkillPaths();
        if (paths.length === 0) {
          return 'No skill directories found.';
        }
        return `**Skill Loading Paths** (highest priority first)\n\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      }

      default:
        return `Unknown action: ${action}. Try: list, info, enable, disable, reload, paths`;
    }
  },
};

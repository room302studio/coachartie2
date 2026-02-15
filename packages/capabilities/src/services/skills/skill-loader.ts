/**
 * OpenClaw-Compatible Skill Loader
 *
 * Loads skills from SKILL.md files in the OpenClaw format and converts
 * them to Coach Artie's RegisteredCapability format.
 *
 * Skill Loading Hierarchy (same as OpenClaw):
 * 1. Workspace skills - ./skills/ (highest priority)
 * 2. User skills - ~/.coachartie/skills/
 * 3. Bundled skills - ./bundled-skills/ (lowest priority)
 *
 * SKILL.md Format:
 * ```markdown
 * ---
 * name: skill-name
 * description: What this skill does
 * user-invocable: true
 * actions:
 *   - action1
 *   - action2
 * requires:
 *   bins: [command1, command2]
 *   env: [ENV_VAR]
 * ---
 *
 * # Skill Name
 *
 * Instructions for the AI on how to use this skill...
 * ```
 */

import { logger } from '@coachartie/shared';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import type { RegisteredCapability, CapabilityContext } from '../capability/capability-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Skill loading paths (OpenClaw-compatible hierarchy)
// Note: __dirname is in dist/services/skills, so we need to go up to find src/skills
const PACKAGE_ROOT = join(__dirname, '../../..');  // Go up to dist/, then to package root
const SKILL_PATHS = [
  join(process.cwd(), 'skills'),                      // Workspace skills (highest)
  join(process.env.HOME || '', '.coachartie/skills'), // User skills
  join(PACKAGE_ROOT, 'src/skills'),                   // Package source skills
  join(PACKAGE_ROOT, 'skills'),                       // Package root skills
  join(__dirname, '../../skills'),                    // Dist skills (if copied)
];

interface SkillFrontmatter {
  name: string;
  description?: string;
  'user-invocable'?: boolean;
  'disable-model-invocation'?: boolean;
  'command-dispatch'?: 'tool' | 'script' | 'handler';
  'command-tool'?: string;
  'command-script'?: string;
  actions?: string[];
  requires?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  metadata?: Record<string, unknown>;
  emoji?: string;
}

interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;
  path: string;
  directory: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error('Invalid SKILL.md: Missing YAML frontmatter');
  }

  const [, yamlContent, body] = frontmatterMatch;

  // Simple YAML parser for frontmatter (handles common cases)
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let currentObject: Record<string, unknown> | null = null;
  let objectKey: string | null = null;

  for (const line of yamlContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ') && currentKey) {
      const value = trimmed.slice(2).trim();
      if (currentArray) {
        currentArray.push(value);
      } else if (currentObject && objectKey) {
        if (!Array.isArray(currentObject[objectKey])) {
          currentObject[objectKey] = [];
        }
        (currentObject[objectKey] as string[]).push(value);
      }
      continue;
    }

    // Nested key (indented)
    if (line.startsWith('  ') && currentObject) {
      const keyMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (keyMatch) {
        objectKey = keyMatch[1];
        const value = keyMatch[2];
        if (value) {
          currentObject[objectKey] = value;
        } else {
          currentObject[objectKey] = [];
        }
      }
      continue;
    }

    // Top-level key
    const keyMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous array/object
      if (currentKey && currentArray) {
        frontmatter[currentKey] = currentArray;
        currentArray = null;
      }
      if (currentKey && currentObject) {
        frontmatter[currentKey] = currentObject;
        currentObject = null;
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2];

      if (!value) {
        // Could be array or object - peek at next line
        const nextLineIndex = yamlContent.split('\n').indexOf(line) + 1;
        const nextLine = yamlContent.split('\n')[nextLineIndex]?.trim() || '';
        if (nextLine.startsWith('- ')) {
          currentArray = [];
        } else if (nextLine.match(/^\w+:/)) {
          currentObject = {};
        }
      } else if (value === 'true') {
        frontmatter[currentKey] = true;
      } else if (value === 'false') {
        frontmatter[currentKey] = false;
      } else if (value.match(/^\d+$/)) {
        frontmatter[currentKey] = parseInt(value, 10);
      } else {
        frontmatter[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Save final array/object
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }
  if (currentKey && currentObject) {
    frontmatter[currentKey] = currentObject;
  }

  return { frontmatter: frontmatter as unknown as SkillFrontmatter, body };
}

/**
 * Check if skill requirements are met
 */
function checkRequirements(requires: SkillFrontmatter['requires']): { met: boolean; missing: string[] } {
  const missing: string[] = [];

  if (requires?.bins) {
    for (const bin of requires.bins) {
      try {
        execSync(`which ${bin}`, { stdio: 'ignore' });
      } catch {
        missing.push(`binary: ${bin}`);
      }
    }
  }

  if (requires?.env) {
    for (const envVar of requires.env) {
      if (!process.env[envVar]) {
        missing.push(`env: ${envVar}`);
      }
    }
  }

  return { met: missing.length === 0, missing };
}

/**
 * Load a single skill from a directory
 */
function loadSkillFromDirectory(skillDir: string): ParsedSkill | null {
  const skillFile = join(skillDir, 'SKILL.md');

  if (!existsSync(skillFile)) {
    return null;
  }

  try {
    const content = readFileSync(skillFile, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) {
      logger.warn(`Skill at ${skillDir} missing required 'name' field`);
      return null;
    }

    return {
      frontmatter,
      content: body,
      path: skillFile,
      directory: skillDir,
    };
  } catch (error) {
    logger.warn(`Failed to load skill from ${skillDir}:`, error);
    return null;
  }
}

/**
 * Create a handler for script-based skills
 */
function createScriptHandler(skill: ParsedSkill): (params: Record<string, unknown>, content?: string, ctx?: CapabilityContext) => Promise<string> {
  const scriptPath = skill.frontmatter['command-script'];

  return async (params, content, ctx) => {
    if (!scriptPath) {
      return 'Skill has no command-script defined';
    }

    const fullScriptPath = join(skill.directory, scriptPath);
    if (!existsSync(fullScriptPath)) {
      return `Skill script not found: ${scriptPath}`;
    }

    try {
      // Pass params as JSON env var
      const env = {
        ...process.env,
        SKILL_PARAMS: JSON.stringify(params),
        SKILL_CONTENT: content || '',
        SKILL_USER_ID: ctx?.userId || '',
        SKILL_GUILD_ID: ctx?.guildId || '',
        SKILL_CHANNEL_ID: ctx?.channelId || '',
      };

      const result = execSync(`bash "${fullScriptPath}"`, {
        cwd: skill.directory,
        env,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      return result.toString().trim();
    } catch (error) {
      const err = error as { message?: string; stderr?: Buffer };
      return `Skill execution error: ${err.message || err.stderr?.toString() || 'Unknown error'}`;
    }
  };
}

/**
 * Create a handler for prompt-only skills (AI interprets the skill content)
 */
function createPromptHandler(skill: ParsedSkill): (params: Record<string, unknown>, content?: string, ctx?: CapabilityContext) => Promise<string> {
  return async (params, content) => {
    // For prompt-only skills, return the skill's instructions
    // The AI will interpret these when the skill is invoked
    const action = params.action || 'help';
    const query = content || params.query || params.input || '';

    return `**${skill.frontmatter.name}** (${action})

${skill.content}

User request: ${query}

Please follow the skill instructions above to respond.`;
  };
}

/**
 * Convert a parsed skill to a RegisteredCapability
 */
function skillToCapability(skill: ParsedSkill): RegisteredCapability | null {
  const { frontmatter } = skill;

  // Check requirements
  if (frontmatter.requires) {
    const { met, missing } = checkRequirements(frontmatter.requires);
    if (!met) {
      logger.info(`Skill '${frontmatter.name}' disabled - missing: ${missing.join(', ')}`);
      return null;
    }
  }

  // Determine handler based on command-dispatch type
  let handler: RegisteredCapability['handler'];

  switch (frontmatter['command-dispatch']) {
    case 'script':
      handler = createScriptHandler(skill);
      break;
    case 'tool':
      // Tool dispatch would call another capability
      handler = async (params) => {
        const toolName = frontmatter['command-tool'];
        return `Tool dispatch to '${toolName}' not yet implemented. Params: ${JSON.stringify(params)}`;
      };
      break;
    default:
      // Default: prompt-based skill
      handler = createPromptHandler(skill);
  }

  // Build actions list
  const actions = frontmatter.actions || ['execute', 'run', 'help'];

  return {
    name: frontmatter.name,
    supportedActions: actions,
    description: `${frontmatter.description || 'OpenClaw skill'}\n\n${skill.content.slice(0, 500)}${skill.content.length > 500 ? '...' : ''}`,
    emoji: frontmatter.emoji,
    handler,
  };
}

/**
 * Discover and load all skills from the hierarchy
 */
export function discoverSkills(): Map<string, RegisteredCapability> {
  const skills = new Map<string, RegisteredCapability>();
  const seenNames = new Set<string>();

  for (const basePath of SKILL_PATHS) {
    if (!existsSync(basePath)) {
      continue;
    }

    try {
      const entries = readdirSync(basePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(basePath, entry.name);
        const skill = loadSkillFromDirectory(skillDir);

        if (skill && !seenNames.has(skill.frontmatter.name)) {
          const capability = skillToCapability(skill);
          if (capability) {
            skills.set(capability.name, capability);
            seenNames.add(capability.name);
            logger.info(`Loaded skill: ${capability.name} from ${skillDir}`);
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to scan skill directory ${basePath}:`, error);
    }
  }

  return skills;
}

/**
 * Load a single skill by name
 */
export function loadSkill(name: string): RegisteredCapability | null {
  for (const basePath of SKILL_PATHS) {
    const skillDir = join(basePath, name);
    const skill = loadSkillFromDirectory(skillDir);

    if (skill) {
      return skillToCapability(skill);
    }
  }

  return null;
}

/**
 * Get skill paths for documentation
 */
export function getSkillPaths(): string[] {
  return SKILL_PATHS.filter(p => existsSync(p));
}

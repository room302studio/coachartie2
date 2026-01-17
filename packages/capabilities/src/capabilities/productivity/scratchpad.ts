import { logger } from '@coachartie/shared';
import { RegisteredCapability, CapabilityContext } from '../../services/capability/capability-registry.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * Scratchpad capability - persistent guild notes
 *
 * Artie's long-term memory for each guild. A place to:
 * - Note community members and their quirks
 * - Track recurring issues and solutions
 * - Remember things that worked or didn't
 * - Build up knowledge over time
 *
 * Persists to disk so knowledge survives restarts.
 */

interface ScratchpadParams {
  action: 'write' | 'read' | 'append' | 'clear' | 'section' | 'note';
  content?: string;
  section?: string;
  guildId?: string;
}

// Base path for guild notes
const NOTES_BASE_PATH = resolve(process.cwd(), 'reference-docs/guild-notes');

// In-memory cache of loaded scratchpads
const scratchpadCache = new Map<string, string>();

// Get the file path for a guild's scratchpad
function getGuildNotesPath(guildId: string): string {
  // Map known guild IDs to their note files
  const guildFiles: Record<string, string> = {
    '1420846272545296470': 'subwaybuilder.md',
    '932719842522443928': 'room302studio.md',
  };

  const filename = guildFiles[guildId] || `guild-${guildId}.md`;
  return resolve(NOTES_BASE_PATH, filename);
}

// Load scratchpad from disk
async function loadScratchpad(guildId: string): Promise<string> {
  // Check cache first
  if (scratchpadCache.has(guildId)) {
    return scratchpadCache.get(guildId)!;
  }

  const filePath = getGuildNotesPath(guildId);

  try {
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8');
      scratchpadCache.set(guildId, content);
      return content;
    }
  } catch (error) {
    logger.warn(`Could not load scratchpad for guild ${guildId}:`, error);
  }

  // Return default template if file doesn't exist
  const template = `# Guild Notes

*Artie's observations and notes about this community*

## Community Members
<!-- People I've interacted with, their interests, quirks -->

## Recurring Topics
<!-- Questions that come up often, common issues -->

## Things I've Learned
<!-- Patterns, solutions that worked, things to remember -->

## Notes
<!-- Ongoing observations -->
`;
  scratchpadCache.set(guildId, template);
  return template;
}

// Save scratchpad to disk
async function saveScratchpad(guildId: string, content: string): Promise<void> {
  const filePath = getGuildNotesPath(guildId);

  try {
    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    scratchpadCache.set(guildId, content);
    logger.info(`📝 Saved guild notes for ${guildId} to ${filePath}`);
  } catch (error) {
    logger.error(`Failed to save scratchpad for guild ${guildId}:`, error);
    throw error;
  }
}

// Format for display
function formatPad(content: string): string {
  if (!content.trim()) {
    return '(empty scratchpad)';
  }

  const lines = content.split('\n');
  const lineCount = lines.length;
  const preview = lines.slice(0, 50).join('\n');

  if (lineCount > 50) {
    return `${preview}\n\n... (${lineCount - 50} more lines)`;
  }

  return content;
}

export const scratchpadCapability: RegisteredCapability = {
  name: 'scratchpad',
  emoji: '📝',
  supportedActions: ['write', 'read', 'append', 'clear', 'section', 'note'],
  description: `Your persistent notes for this guild. Write down observations, community member quirks, recurring issues - things you want to remember.

IMPORTANT: These notes persist across restarts. Use them to build knowledge over time!

Use this to:
- Note interesting community members and what they're into
- Track recurring questions or issues
- Remember solutions that worked
- Observe patterns in the community

Actions:
- note: Quick note (appends with timestamp) - USE THIS MOST
- read: See your notes
- section: Add to a specific section (Community Members, Recurring Topics, etc.)
- append: Add to the end
- write: Replace everything (careful!)
- clear: Wipe notes (very careful!)

When you learn something unique about this guild - a person, a pattern, a solution - jot it down!`,
  requiredParams: [],
  examples: [
    // Quick note (most common)
    `<capability name="scratchpad" action="note" content="jan_gbg likes to tease me about errors - give it back to him playfully" />`,

    // Adding to a section
    `<capability name="scratchpad" action="section" section="Community Members" content="Hudson - very active modder, helpful to newcomers" />`,

    // Noting a recurring issue
    `<capability name="scratchpad" action="section" section="Recurring Topics" content="License transfer questions come up often - direct to support@subwaybuilder.com" />`,

    // Reading back
    '<capability name="scratchpad" action="read" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const { action = 'read', content, section } = params as ScratchpadParams;

    // Get guild ID from context or params
    const guildId = context?.guildId || params.guildId || 'default';
    logger.info(
      `📝 Scratchpad context: guildId=${guildId} (from context: ${context?.guildId}, from params: ${params.guildId})`
    );

    // Use content from params or from capability content
    const text = content || _content || '';

    logger.info(`📝 Scratchpad [${guildId}]: ${action}${section ? ` [${section}]` : ''}`);

    try {
      switch (action) {
        case 'write': {
          if (!text) {
            return `Error: content required for write. Usage: action="write" content="your notes"`;
          }

          await saveScratchpad(guildId, text);
          const lineCount = text.split('\n').length;
          return `Wrote ${lineCount} lines to guild notes.`;
        }

        case 'read': {
          const pad = await loadScratchpad(guildId);
          return `--- Guild Notes ---\n${formatPad(pad)}`;
        }

        case 'note': {
          if (!text) {
            return `Error: content required for note. Usage: action="note" content="something I learned"`;
          }

          const current = await loadScratchpad(guildId);
          const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
          const newContent = current + `\n- [${timestamp}] ${text}`;

          await saveScratchpad(guildId, newContent);
          return `📝 Noted!`;
        }

        case 'append': {
          if (!text) {
            return `Error: content required for append. Usage: action="append" content="more notes"`;
          }

          const current = await loadScratchpad(guildId);
          const separator = current ? '\n' : '';
          const newContent = current + separator + text;

          await saveScratchpad(guildId, newContent);
          return `Appended to guild notes (now ${newContent.split('\n').length} lines)`;
        }

        case 'section': {
          if (!section) {
            return `Error: section name required. Usage: action="section" section="Community Members" content="..."`;
          }

          const current = await loadScratchpad(guildId);

          // Try to find existing section and append to it
          const sectionHeader = `## ${section}`;
          const sectionIndex = current.indexOf(sectionHeader);

          let newContent: string;
          if (sectionIndex !== -1 && text) {
            // Find where this section ends (next ## or end of file)
            const afterSection = current.substring(sectionIndex + sectionHeader.length);
            const nextSectionMatch = afterSection.match(/\n## /);

            if (nextSectionMatch && nextSectionMatch.index !== undefined) {
              // Insert before next section
              const insertPoint = sectionIndex + sectionHeader.length + nextSectionMatch.index;
              newContent =
                current.substring(0, insertPoint) + `\n- ${text}` + current.substring(insertPoint);
            } else {
              // Append to end of this section (end of file)
              newContent = current + `\n- ${text}`;
            }
          } else if (text) {
            // Section doesn't exist, create it
            newContent = current + `\n\n## ${section}\n- ${text}`;
          } else {
            newContent = current + `\n\n## ${section}`;
          }

          await saveScratchpad(guildId, newContent.trim());
          return `Added to section: ${section}`;
        }

        case 'clear': {
          const template = `# Guild Notes\n\n*Cleared on ${new Date().toISOString().split('T')[0]}*\n`;
          await saveScratchpad(guildId, template);
          return 'Guild notes cleared (template restored).';
        }

        default:
          return `Unknown action: ${action}
Available: note, read, section, append, write, clear`;
      }
    } catch (error: any) {
      logger.error(`Scratchpad failed:`, { action, guildId, error: error.message });
      return `Scratchpad error: ${error.message}`;
    }
  },
};

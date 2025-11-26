import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Scratchpad capability - externalized thinking
 *
 * This is like my thinking blocks but for Artie. A place to:
 * - Reason through complex problems step by step
 * - Keep notes that persist across the conversation
 * - Plan multi-step tasks before executing
 * - Track what's been tried and what worked
 *
 * The key insight: thinking out loud leads to better reasoning.
 * Instead of keeping it all in the context window, write it down.
 */

interface ScratchpadParams {
  action: 'write' | 'read' | 'append' | 'clear' | 'section';
  content?: string;
  section?: string;
}

// In-memory scratchpad (per conversation/session)
// In production, this could persist to Redis with a conversation ID
const scratchpads = new Map<string, string>();
const DEFAULT_PAD = 'default';

// Format the scratchpad nicely
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
  supportedActions: ['write', 'read', 'append', 'clear', 'section'],
  description: `Your thinking space. Write down reasoning, plans, notes - externalize your thought process.

Use this to:
- Break down complex problems step by step
- Plan before you act
- Track what you've tried
- Keep notes for later in the conversation

Actions:
- write: Replace scratchpad content
- read: See what's written
- append: Add to existing content
- section: Add a labeled section (## heading)
- clear: Start fresh

Think out loud. It leads to better reasoning.`,
  requiredParams: [],
  examples: [
    // Planning
    `<capability name="scratchpad" action="write" content="## Plan
1. First, understand the current code structure
2. Find where the bug originates
3. Write a fix
4. Test it" />`,

    // Adding thoughts
    `<capability name="scratchpad" action="append" content="
Observation: The error happens in the auth middleware.
The token validation is failing because..." />`,

    // Sections for organization
    '<capability name="scratchpad" action="section" section="What I Found" content="The bug is in line 42..." />',

    // Reading back
    '<capability name="scratchpad" action="read" />',

    // Starting fresh
    '<capability name="scratchpad" action="clear" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const { action = 'read', content, section } = params as ScratchpadParams;

    // Use content from params or from capability content
    const text = content || _content || '';

    logger.info(`Scratchpad: ${action}${section ? ` [${section}]` : ''}`);

    try {
      switch (action) {
        case 'write': {
          if (!text) {
            return `Error: content required for write. Usage: action="write" content="your notes"`;
          }

          scratchpads.set(DEFAULT_PAD, text);

          const lineCount = text.split('\n').length;
          return `Wrote ${lineCount} lines to scratchpad.`;
        }

        case 'read': {
          const pad = scratchpads.get(DEFAULT_PAD) || '';
          return `--- Scratchpad ---\n${formatPad(pad)}`;
        }

        case 'append': {
          if (!text) {
            return `Error: content required for append. Usage: action="append" content="more notes"`;
          }

          const current = scratchpads.get(DEFAULT_PAD) || '';
          const separator = current ? '\n' : '';
          const newContent = current + separator + text;

          scratchpads.set(DEFAULT_PAD, newContent);

          return `Appended to scratchpad (now ${newContent.split('\n').length} lines)`;
        }

        case 'section': {
          if (!section) {
            return `Error: section name required. Usage: action="section" section="My Section" content="..."`;
          }

          const current = scratchpads.get(DEFAULT_PAD) || '';
          const sectionContent = text ? `\n${text}` : '';
          const newContent = current + `\n\n## ${section}${sectionContent}`;

          scratchpads.set(DEFAULT_PAD, newContent.trim());

          return `Added section: ${section}`;
        }

        case 'clear': {
          const hadContent = scratchpads.has(DEFAULT_PAD);
          scratchpads.delete(DEFAULT_PAD);

          return hadContent ? 'Scratchpad cleared.' : 'Scratchpad was already empty.';
        }

        default:
          return `Unknown action: ${action}
Available: write, read, append, section, clear`;
      }
    } catch (error: any) {
      logger.error(`Scratchpad failed:`, { action, error: error.message });
      return `Scratchpad error: ${error.message}`;
    }
  },
};

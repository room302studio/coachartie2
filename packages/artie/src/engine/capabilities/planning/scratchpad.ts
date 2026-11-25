import { logger } from '../../../shared/logger.js';
import { GUILD_NOTES_DIR, getGuildDocsRoot } from '../../../shared/paths.js';
import { getGuildConfig } from '../../../shared/config/guilds.js';
import { RegisteredCapability, CapabilityContext } from '../registry.js';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { dirname, resolve } from 'path';

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

function sectionSuffix(section: string | undefined): string {
  if (section) {
    return ` [${section}]`;
  }
  return '';
}

function appendSeparator(current: string): string {
  if (current) {
    return '\n';
  }
  return '';
}

/**
 * One load-modify-save at a time per file, so two notes in the same moment both land (one
 * process: engine and gateway are one PM2 app). No content cache: the file is also edited by
 * hand and read by the gateway, so the disk is the only truth.
 */
const padLocks = new Map<string, Promise<unknown>>();

async function withPadLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = padLocks.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  padLocks.set(filePath, next);
  try {
    return await next;
  } finally {
    if (padLocks.get(filePath) === next) {
      padLocks.delete(filePath);
    }
  }
}

/**
 * Which pad a call uses (2026-11-17 merge). Inside a conversation: that server's pad, or in a DM
 * a pad for that one person (it used to be one 'default' pad shared by every DM user). A
 * model-supplied guildId is honored only for context-less internal callers, so a conversation
 * can't read or write another server's pad.
 */
export function scratchpadKey(
  context: { guildId?: string; userId?: string } | undefined,
  paramGuildId: unknown
): string {
  if (context) {
    if (context.guildId) {
      return context.guildId;
    }
    const who = String(context.userId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
    return `dm-${who}`;
  }
  if (typeof paramGuildId === 'string' && /^[A-Za-z0-9_-]+$/.test(paramGuildId)) {
    return paramGuildId;
  }
  return 'default';
}

/**
 * The pad's file: the guild's `scratchpadPath` from shared/config/guilds.ts, which is the same
 * file gateway/1-receive/guild-context.ts puts in that guild's context every turn, so what
 * Artie writes he sees next turn. Other keys (dm-<user>, default, unconfigured guilds) get
 * `guild-<key>.md` in GUILD_NOTES_DIR.
 */
export function getGuildNotesPath(key: string): string {
  const configured = getGuildConfig(key)?.scratchpadPath;
  if (configured) {
    return resolve(getGuildDocsRoot(), configured);
  }
  return resolve(GUILD_NOTES_DIR, `guild-${key}.md`);
}

// Load scratchpad from disk. Only a MISSING file starts from the template: any other read
// error is thrown, so a write can never replace notes it failed to read (Codex, 2026-11-24).
async function loadScratchpad(guildId: string): Promise<string> {
  try {
    return await readFile(getGuildNotesPath(guildId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return PAD_TEMPLATE;
}

const PAD_TEMPLATE = `# Guild Notes

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

// Save scratchpad to disk
async function saveScratchpad(guildId: string, content: string): Promise<void> {
  const filePath = getGuildNotesPath(guildId);

  try {
    // Ensure directory exists
    await mkdir(dirname(filePath), { recursive: true });
    // Temp file + rename, so the gateway (which reads the pad without the lock) never sees a
    // half-written file.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
    logger.info(`📝 Saved guild notes for ${guildId} to ${filePath}`);
  } catch (error) {
    logger.error(`Failed to save scratchpad for guild ${guildId}:`, error);
    throw error;
  }
}

/** Index of the line that is exactly `heading` (trailing spaces allowed), or -1. */
export function findHeadingLine(content: string, heading: string): number {
  let offset = 0;
  for (const line of content.split('\n')) {
    if (line.trimEnd() === heading) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
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
  // The pad is ONE markdown file per server (getGuildNotesPath), shared by everyone Artie talks
  // to there; each DM user gets their own pad (scratchpadKey). Two kinds of
  // write: adding a line (note/append/section) is Artie's own state; replacing or wiping the whole
  // file (write/clear) is destructive, so it is taint-blocked like other workspace writes.
  actions: {
    read: { effect: 'read' },
    note: { effect: 'own', content: 'The note, one line' },
    append: { effect: 'own', content: 'Text to add at the end' },
    section: {
      effect: 'own',
      content: 'Text to add under that section',
      params: {
        section: {
          type: 'string',
          description: 'Section heading, e.g. Community Members (created if missing)',
          required: true,
        },
      },
    },
    write: { effect: 'workspace', content: 'The whole new notebook text (replaces everything)' },
    clear: { effect: 'workspace' },
  },
  supportedActions: ['write', 'read', 'append', 'clear', 'section', 'note'],
  description: `Your running free-form notebook for THIS server: patterns and observations, not single searchable facts (use memory for those). Shared by everyone there; no tags or search.

Notes persist across restarts and may be shown back to you in this server's context.

Actions:
- note: Quick dated line at the end - USE THIS MOST
- read: See the whole notebook
- section: Add a line under a heading (Community Members, Recurring Topics, ...)
- append: Add text to the end
- write: Replace everything (careful!)
- clear: Wipe it (very careful!)

Use it for community quirks, recurring questions, solutions that worked. Facts about a person that should follow them across servers go in memory (scope me).`,
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

    const guildId = scratchpadKey(context, params.guildId);
    logger.info(
      `📝 Scratchpad context: guildId=${guildId} (from context: ${context?.guildId}, from params: ${params.guildId})`
    );

    // Use content from params or from capability content
    const text = content || _content || '';

    logger.info(`📝 Scratchpad [${guildId}]: ${action}${sectionSuffix(section)}`);

    try {
      return await withPadLock(getGuildNotesPath(guildId), () =>
        runPadAction(action, guildId, text, section)
      );
    } catch (error: any) {
      logger.error(`Scratchpad failed:`, { action, guildId, error: error.message });
      return `Scratchpad error: ${error.message}`;
    }
  },
};

async function runPadAction(
  action: ScratchpadParams['action'],
  guildId: string,
  text: string,
  section: string | undefined
): Promise<string> {
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
      const separator = appendSeparator(current);
      const newContent = current + separator + text;

      await saveScratchpad(guildId, newContent);
      return `Appended to guild notes (now ${newContent.split('\n').length} lines)`;
    }

    case 'section': {
      if (!section) {
        return `Error: section name required. Usage: action="section" section="Community Members" content="..."`;
      }

      const current = await loadScratchpad(guildId);

      // Find the section by its WHOLE heading line ("Community" must not match
      // "## Community Members") and append to it
      const sectionHeader = `## ${section}`;
      const sectionIndex = findHeadingLine(current, sectionHeader);

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
}

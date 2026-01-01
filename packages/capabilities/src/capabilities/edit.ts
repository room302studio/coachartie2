import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

/**
 * Edit capability - surgical file editing like Claude Code's Edit tool
 *
 * The key insight: LLMs are bad at rewriting whole files but great at
 * specifying "replace X with Y". This capability makes that easy.
 *
 * Returns terminal-native output (diffs, confirmations) not JSON.
 */

interface EditParams {
  action: 'replace' | 'insert' | 'delete' | 'read';
  file: string;
  old_string?: string;
  new_string?: string;
  line?: number;
  replace_all?: boolean;
}

// Execute in sandbox container
async function execInContainer(command: string, timeout: number = 30000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec ${containerName} /bin/bash -c ${JSON.stringify(command)}`;

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 5,
    env: process.env,
  });
}

// Read file with line numbers (like Claude Code's Read tool)
async function readWithLineNumbers(
  file: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  let command = `cat -n "${file}"`;

  if (startLine && endLine) {
    command = `sed -n '${startLine},${endLine}p' "${file}" | cat -n | sed 's/^\\s*//' | awk '{printf "%5d\\t%s\\n", NR + ${startLine - 1}, substr($0, index($0,$2))}'`;
  } else if (startLine) {
    command = `tail -n +${startLine} "${file}" | cat -n | sed 's/^\\s*//' | awk '{printf "%5d\\t%s\\n", NR + ${startLine - 1}, substr($0, index($0,$2))}'`;
  }

  try {
    const { stdout } = await execInContainer(command);
    return stdout;
  } catch (error: any) {
    if (error.stderr?.includes('No such file')) {
      throw new Error(`File not found: ${file}`);
    }
    throw error;
  }
}

// Count occurrences of a string in file
async function countOccurrences(file: string, searchString: string): Promise<number> {
  // Escape for grep
  const escaped = searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const command = `grep -c -F "${escaped.replace(/"/g, '\\"')}" "${file}" || echo 0`;

  try {
    const { stdout } = await execInContainer(command);
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

// Find line numbers where string occurs
async function findLineNumbers(file: string, searchString: string): Promise<number[]> {
  const escaped = searchString.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const command = `grep -n -F "${escaped}" "${file}" | cut -d: -f1`;

  try {
    const { stdout } = await execInContainer(command);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((n) => parseInt(n));
  } catch {
    return [];
  }
}

// Perform the replacement
async function replaceInFile(
  file: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<{ linesChanged: number[]; diff: string }> {
  // Create a temp file with the replacement
  const timestamp = Date.now();
  const tempFile = `/tmp/edit_${timestamp}.txt`;
  const backupFile = `/tmp/edit_backup_${timestamp}.txt`;

  // Backup original
  await execInContainer(`cp "${file}" "${backupFile}"`);

  // Use node for reliable string replacement (sed is painful with special chars)
  const script = `
    const fs = require('fs');
    const content = fs.readFileSync('${file}', 'utf8');
    const oldStr = ${JSON.stringify(oldString)};
    const newStr = ${JSON.stringify(newString)};
    const replaceAll = ${replaceAll};

    let result;
    if (replaceAll) {
      result = content.split(oldStr).join(newStr);
    } else {
      const idx = content.indexOf(oldStr);
      if (idx === -1) {
        console.error('STRING_NOT_FOUND');
        process.exit(1);
      }
      result = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    }

    fs.writeFileSync('${file}', result);
    console.log('OK');
  `;

  try {
    await execInContainer(`node -e ${JSON.stringify(script)}`);
  } catch (error: any) {
    // Restore backup on failure
    await execInContainer(`mv "${backupFile}" "${file}"`);
    if (error.stderr?.includes('STRING_NOT_FOUND')) {
      throw new Error(`String not found in ${file}`);
    }
    throw error;
  }

  // Generate diff
  const { stdout: diff } = await execInContainer(`diff -u "${backupFile}" "${file}" || true`);

  // Find which lines changed
  const linesChanged = await findLineNumbers(file, newString);

  // Cleanup
  await execInContainer(`rm -f "${backupFile}" "${tempFile}"`);

  return { linesChanged, diff };
}

export const editCapability: RegisteredCapability = {
  name: 'edit',
  emoji: '✏️',
  supportedActions: ['replace', 'read', 'insert', 'delete'],
  description: `Surgical file editing in your laptop. Don't rewrite whole files - just specify what to change.

Actions:
- read: See file with line numbers (crucial for knowing WHERE to edit)
- replace: Find old_string and replace with new_string
- insert: Add text at a specific line
- delete: Remove a specific line or range

The replace action fails if old_string isn't found or isn't unique (unless replace_all=true).
This forces precision - you have to know exactly what you're changing.

Always READ first to see line numbers, then EDIT with confidence.`,
  requiredParams: ['file'],
  examples: [
    // Read with line numbers - essential first step
    '<capability name="edit" action="read" file="/workspace/app.js" />',

    // Read specific line range
    '<capability name="edit" action="read" file="/workspace/app.js" line="10-25" />',

    // Surgical replacement
    '<capability name="edit" action="replace" file="/workspace/config.js" old_string="port: 3000" new_string="port: 8080" />',

    // Multi-line replacement
    `<capability name="edit" action="replace" file="/workspace/index.js" old_string="function old() {
  return 1;
}" new_string="function new() {
  return 2;
}" />`,

    // Replace all occurrences
    '<capability name="edit" action="replace" file="/workspace/app.js" old_string="var " new_string="const " replace_all="true" />',

    // Insert at line
    '<capability name="edit" action="insert" file="/workspace/app.js" line="1" new_string="// Header comment" />',

    // Delete line
    '<capability name="edit" action="delete" file="/workspace/debug.js" line="15" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const {
      action = 'read',
      file,
      old_string,
      new_string,
      line,
      replace_all = false,
    } = params as EditParams;

    if (!file) {
      return `Error: file parameter required. Usage: action="read" file="/workspace/yourfile.js"`;
    }

    try {
      switch (action) {
        case 'read': {
          // Parse line range if provided (e.g., "10-25" or "10")
          let startLine: number | undefined;
          let endLine: number | undefined;

          if (line) {
            const lineStr = String(line);
            if (lineStr.includes('-')) {
              const [start, end] = lineStr.split('-').map((n) => parseInt(n.trim()));
              startLine = start;
              endLine = end;
            } else {
              startLine = parseInt(lineStr);
              endLine = startLine + 50; // Default to 50 lines from start
            }
          }

          logger.info(
            `Reading ${file}${startLine ? ` (lines ${startLine}-${endLine || 'end'})` : ''}`
          );

          const content = await readWithLineNumbers(file, startLine, endLine);

          // Truncate if too long
          const lines = content.split('\n');
          const maxLines = 200;
          if (lines.length > maxLines) {
            const truncated = [
              ...lines.slice(0, 100),
              `\n... ${lines.length - maxLines} lines omitted ...\n`,
              ...lines.slice(-100),
            ].join('\n');
            return `${file}:\n${truncated}`;
          }

          return `${file}:\n${content}`;
        }

        case 'replace': {
          if (!old_string) {
            return `Error: old_string required for replace. What text should I find?`;
          }
          if (new_string === undefined) {
            return `Error: new_string required for replace. What should I replace it with?`;
          }

          logger.info(
            `Replacing in ${file}: "${old_string.slice(0, 50)}..." -> "${new_string.slice(0, 50)}..."`
          );

          // Check how many times old_string appears
          const count = await countOccurrences(file, old_string);

          if (count === 0) {
            // Help the LLM by showing nearby content
            const content = await readWithLineNumbers(file);
            const preview = content.split('\n').slice(0, 30).join('\n');
            return `String not found in ${file}.

Here's the beginning of the file:
${preview}
...

Make sure old_string matches exactly (including whitespace).`;
          }

          if (count > 1 && !replace_all) {
            const lineNums = await findLineNumbers(file, old_string);
            return `Found ${count} occurrences of old_string in ${file} (lines: ${lineNums.join(', ')}).

Either:
1. Make old_string more specific (include surrounding context)
2. Use replace_all="true" to replace all occurrences`;
          }

          // Do the replacement
          const { diff } = await replaceInFile(file, old_string, new_string, replace_all);

          // Format diff nicely
          const diffLines = diff.split('\n').slice(2); // Skip header
          const formattedDiff = diffLines
            .filter((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@'))
            .slice(0, 30) // Limit diff output
            .join('\n');

          return `Edited ${file}${count > 1 ? ` (${count} replacements)` : ''}:
${formattedDiff || '(no visible diff)'}`;
        }

        case 'insert': {
          if (!line) {
            return `Error: line number required for insert. Which line should I insert at?`;
          }
          if (!new_string) {
            return `Error: new_string required for insert. What should I insert?`;
          }

          const lineNum = parseInt(String(line));
          logger.info(`Inserting at ${file}:${lineNum}`);

          // Use sed to insert
          const escaped = new_string.replace(/'/g, "'\\''");
          await execInContainer(`sed -i '${lineNum}i\\${escaped}' "${file}"`);

          return `Inserted at ${file}:${lineNum}:
+ ${new_string.split('\n')[0]}${new_string.includes('\n') ? '\n  ...' : ''}`;
        }

        case 'delete': {
          if (!line) {
            return `Error: line number required for delete. Which line should I delete?`;
          }

          const lineStr = String(line);
          let range: string;

          if (lineStr.includes('-')) {
            range = lineStr; // e.g., "10-15"
          } else {
            range = lineStr; // Single line
          }

          logger.info(`Deleting ${file}:${range}`);

          // Show what we're deleting first
          const toDelete = await execInContainer(`sed -n '${range}p' "${file}"`);

          // Delete the line(s)
          await execInContainer(`sed -i '${range}d' "${file}"`);

          const preview = toDelete.stdout
            .split('\n')
            .slice(0, 3)
            .map((l) => `- ${l}`)
            .join('\n');
          return `Deleted ${file}:${range}:
${preview}${toDelete.stdout.split('\n').length > 3 ? '\n  ...' : ''}`;
        }

        default:
          return `Unknown action: ${action}
Available: read, replace, insert, delete`;
      }
    } catch (error: any) {
      logger.error(`Edit failed:`, { action, file, error: error.message });
      return `Error editing ${file}: ${error.message}`;
    }
  },
};

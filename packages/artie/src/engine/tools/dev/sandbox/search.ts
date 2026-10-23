import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

const execAsync = promisify(exec);

/**
 * Search capability - fast file finding and content search
 *
 * Modeled after Claude Code's Glob and Grep tools.
 * LLMs need to quickly find files and search content without
 * constructing complex shell commands.
 *
 * Returns terminal-native output optimized for LLM consumption.
 */

interface SearchParams {
  action: 'files' | 'content' | 'both';
  pattern: string;
  path?: string;
  type?: string; // File extension filter: js, py, ts, etc.
  context?: number; // Lines of context for content search
  limit?: number; // Max results
  ignore_case?: boolean;
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

// Find files by pattern (like Glob)
async function findFiles(
  pattern: string,
  basePath: string = '/workspace',
  fileType?: string,
  limit: number = 50
): Promise<string[]> {
  // Use fd if available (faster), fallback to find
  let command: string;

  // Check if it's a glob pattern or simple name
  const isGlob = pattern.includes('*') || pattern.includes('?') || pattern.includes('[');

  if (isGlob) {
    // fd with glob pattern
    command = `fd --glob '${pattern}' ${basePath} --type f`;
    if (fileType) {
      command += ` --extension ${fileType}`;
    }
  } else {
    // Search for filename containing pattern
    command = `fd '${pattern}' ${basePath} --type f`;
    if (fileType) {
      command += ` --extension ${fileType}`;
    }
  }

  // Sort by modification time (most recent first) and limit
  command += ` | head -${limit} | xargs -r ls -t 2>/dev/null || true`;

  try {
    const { stdout } = await execInContainer(command);
    const files = stdout.trim().split('\n').filter(Boolean);

    // If fd fails, fallback to find
    if (files.length === 0) {
      const fallback = `find ${basePath} -type f -name '*${pattern}*' 2>/dev/null | head -${limit}`;
      const { stdout: fallbackOut } = await execInContainer(fallback);
      return fallbackOut.trim().split('\n').filter(Boolean);
    }

    return files;
  } catch (_error) {
    // Fallback to find
    const fallback = `find ${basePath} -type f -name '*${pattern}*' 2>/dev/null | head -${limit}`;
    try {
      const { stdout } = await execInContainer(fallback);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

// Search file contents (like Grep)
async function searchContent(
  pattern: string,
  basePath: string = '/workspace',
  fileType?: string,
  context: number = 2,
  limit: number = 30,
  ignoreCase: boolean = false
): Promise<{ file: string; line: number; match: string; context?: string[] }[]> {
  // Use ripgrep (rg) for fast searching
  let command = `rg`;

  if (ignoreCase) {
    command += ' -i';
  }

  // Show line numbers
  command += ' -n';

  // Context lines
  if (context > 0) {
    command += ` -C ${context}`;
  }

  // File type filter
  if (fileType) {
    command += ` --type ${fileType}`;
  }

  // Limit results
  command += ` --max-count 5`; // Max per file

  // The pattern and path
  command += ` '${pattern.replace(/'/g, "'\\''")}' ${basePath}`;

  // Overall limit
  command += ` | head -${limit * 5}`; // Account for context lines

  try {
    const { stdout } = await execInContainer(command);
    const lines = stdout.trim().split('\n').filter(Boolean);

    // Parse rg output into structured results
    const results: { file: string; line: number; match: string }[] = [];
    let currentFile = '';

    for (const line of lines) {
      // rg format: file:line:content or file-line-content (for context)
      const colonMatch = line.match(/^(.+?):(\d+)[:-](.*)$/);
      if (colonMatch) {
        const [, file, lineNum, content] = colonMatch;
        if (file !== currentFile) {
          currentFile = file;
        }
        results.push({
          file,
          line: parseInt(lineNum),
          match: content,
        });
      }
    }

    return results.slice(0, limit);
  } catch (error: any) {
    // rg returns exit code 1 when no matches
    if (error.code === 1) {
      return [];
    }

    // Fallback to grep
    try {
      let grepCmd = `grep -rn`;
      if (ignoreCase) grepCmd += ' -i';
      if (context > 0) grepCmd += ` -C ${context}`;
      grepCmd += ` '${pattern.replace(/'/g, "'\\''")}' ${basePath}`;
      if (fileType) grepCmd += ` --include='*.${fileType}'`;
      grepCmd += ` | head -${limit * 5}`;

      const { stdout } = await execInContainer(grepCmd);
      const lines = stdout.trim().split('\n').filter(Boolean);

      return lines.slice(0, limit).map((line) => {
        const match = line.match(/^(.+?):(\d+)[:-](.*)$/);
        if (match) {
          return { file: match[1], line: parseInt(match[2]), match: match[3] };
        }
        return { file: 'unknown', line: 0, match: line };
      });
    } catch {
      return [];
    }
  }
}

// Format results as terminal-native output
function formatFileResults(files: string[], pattern: string, basePath: string): string {
  if (files.length === 0) {
    return `No files matching '${pattern}' in ${basePath}`;
  }

  const lines = [`Files matching '${pattern}' (${files.length} found):`];

  for (const file of files) {
    // Show relative path from workspace
    const relative = file.replace('/workspace/', '');
    lines.push(`  ${relative}`);
  }

  if (files.length >= 50) {
    lines.push(`  ... (limited to 50 results)`);
  }

  return lines.join('\n');
}

function formatContentResults(
  results: { file: string; line: number; match: string }[],
  pattern: string,
  basePath: string
): string {
  if (results.length === 0) {
    return `No matches for '${pattern}' in ${basePath}`;
  }

  const lines = [`Matches for '${pattern}' (${results.length} results):`];

  // Group by file
  const byFile = new Map<string, typeof results>();
  for (const r of results) {
    const existing = byFile.get(r.file) || [];
    existing.push(r);
    byFile.set(r.file, existing);
  }

  for (const [file, matches] of byFile) {
    const relative = file.replace('/workspace/', '');
    lines.push(`\n${relative}:`);
    for (const m of matches) {
      // Truncate long lines
      const display = m.match.length > 100 ? m.match.slice(0, 100) + '...' : m.match;
      lines.push(`  ${m.line}: ${display}`);
    }
  }

  return lines.join('\n');
}

export const searchCapability: RegisteredCapability = {
  name: 'search',
  emoji: '🔍',
  supportedActions: ['files', 'content', 'both'],
  description: `Fast file finding and content search in your laptop.

Actions:
- files: Find files by name pattern (like glob)
- content: Search inside files (like grep/ripgrep)
- both: Find files AND search their content

Results come back as simple text you can read and reason about.

Tips:
- Use glob patterns: "*.js", "**/*.test.ts", "config.*"
- Use type filter: type="js" to search only JavaScript files
- Use context=3 to see surrounding lines`,
  requiredParams: ['pattern'],
  examples: [
    // Find files by pattern
    '<capability name="search" action="files" pattern="*.ts" />',
    '<capability name="search" action="files" pattern="config" path="/workspace/src" />',

    // Search content
    '<capability name="search" action="content" pattern="TODO" />',
    '<capability name="search" action="content" pattern="export function" type="ts" />',
    '<capability name="search" action="content" pattern="error" context="3" ignore_case="true" />',

    // Combined search
    '<capability name="search" action="both" pattern="handler" type="ts" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const {
      action = 'both',
      pattern,
      path = '/workspace',
      type,
      context = 2,
      limit = 30,
      ignore_case = false,
    } = params as SearchParams;

    if (!pattern) {
      return `Error: pattern required. Usage: action="files" pattern="*.ts"`;
    }

    logger.info(`Search: ${action} for '${pattern}' in ${path}`);

    try {
      switch (action) {
        case 'files': {
          const files = await findFiles(pattern, path, type, limit);
          return formatFileResults(files, pattern, path);
        }

        case 'content': {
          const results = await searchContent(pattern, path, type, context, limit, ignore_case);
          return formatContentResults(results, pattern, path);
        }

        case 'both': {
          // First find files matching the pattern
          const files = await findFiles(pattern, path, type, Math.floor(limit / 2));

          // Then search content
          const contentResults = await searchContent(
            pattern,
            path,
            type,
            context,
            Math.floor(limit / 2),
            ignore_case
          );

          const parts: string[] = [];

          if (files.length > 0) {
            parts.push(formatFileResults(files, pattern, path));
          }

          if (contentResults.length > 0) {
            if (parts.length > 0) parts.push('');
            parts.push(formatContentResults(contentResults, pattern, path));
          }

          if (parts.length === 0) {
            return `No files or content matching '${pattern}' in ${path}`;
          }

          return parts.join('\n');
        }

        default:
          return `Unknown action: ${action}
Available: files, content, both`;
      }
    } catch (error: any) {
      logger.error(`Search failed:`, { action, pattern, error: error.message });
      return `Error searching: ${error.message}`;
    }
  },
};

/**
 * sandbox: Artie's Linux laptop.
 *
 * One tool for everything that runs inside the sandbox container (`docker exec` into
 * SANDBOX_CONTAINER_NAME, default `coachartie-sandbox`). Merged on 2026-10-23 (wave 4) from four
 * tools that all targeted that same container: `shell`, `edit`, `git` and the dev `search`.
 * Each original handler survives unchanged as an internal function below; only the action names
 * that collided were renamed:
 *
 *   shell  exec/send/split, read → read_pane, list → list_panes
 *   edit   read → read_file, replace/insert/delete
 *   git    <verb> → git_<verb> (status, diff, log, branch, show, blame)
 *   search files → find_files, content → grep, both → search
 *
 * The old names still work through TOOL_ALIASES in 5-tool-loop/registry.ts.
 * The docker command strings are byte-identical to the pre-merge files (each section keeps its
 * own exec helper, because their -w / -e flags differ).
 */

import { logger } from '../../../shared/logger.js';
import { delay } from '../../../shared/async.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { marked } from 'marked';

const execAsync = promisify(exec);

// =====================================================================================
// shell: exec, send, read_pane, split, list_panes (was the `shell` tool)
// =====================================================================================

// Output limits for LLM-friendly truncation
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 50000;

interface ShellParams {
  command?: string;
  action?: 'exec' | 'send' | 'read' | 'split' | 'list';
  session?: string;
  pane?: number;
  cwd?: string;
  timeout?: number;
  direction?: 'horizontal' | 'vertical';
  lines?: number;
}

// Helper to execute command in sandbox container
async function execInContainer(command: string, timeout: number = 30000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';

  const dockerCommand = [
    'docker',
    'exec',
    '-e',
    `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
    '-e',
    `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
    containerName,
    '/bin/bash',
    '-c',
    command,
  ].join(' ');

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 5,
    env: process.env,
  });
}

// Helper to ensure tmux session exists
async function ensureSession(session: string, cwd: string = '/workspace') {
  try {
    await execInContainer(`tmux has-session -t ${session} 2>/dev/null`);
  } catch {
    logger.info(`Creating new tmux session: ${session}`);
    await execInContainer(`tmux new-session -d -s ${session} -c ${cwd}`);
  }
}

// Helper to extract code from markdown fence
function extractCodeFromMarkdown(content: string): { code: string; lang?: string } | null {
  if (!content || !content.includes('```')) {
    return null;
  }

  try {
    const tokens = marked.lexer(content);
    const codeToken = tokens.find((t) => t.type === 'code');

    if (codeToken && 'text' in codeToken) {
      return {
        code: codeToken.text,
        lang: 'lang' in codeToken ? codeToken.lang : undefined,
      };
    }
  } catch (error) {
    logger.warn('Failed to parse markdown code block:', error);
  }

  return null;
}

// Helper to detect nested heredoc
function hasNestedHeredoc(code: string): boolean {
  const heredocPattern = /<<\s*['"']?\w+['"']?/;
  return heredocPattern.test(code);
}

// Format output like a terminal transcript - this is the key insight
// LLMs reason about text, not JSON schemas
function formatTerminalOutput(opts: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  truncated?: boolean;
  truncatedLines?: number;
}): string {
  const lines: string[] = [];

  // Show the command with prompt (like a real terminal)
  lines.push(`$ ${opts.command}`);

  // Combine stdout and stderr naturally
  const output = [opts.stdout, opts.stderr].filter(Boolean).join('\n');

  if (output) {
    lines.push(output);
  }

  // Truncation notice if needed
  if (opts.truncated) {
    lines.push(`[...truncated ${opts.truncatedLines} lines...]`);
  }

  // Exit code only shown on failure (like a real terminal experience)
  if (opts.exitCode !== 0) {
    lines.push(`[exit ${opts.exitCode}]`);
  }

  // Show current directory context
  lines.push(`[${opts.cwd}]`);

  return lines.join('\n');
}

// Truncate output intelligently for LLM consumption
function truncateOutput(output: string): {
  text: string;
  truncated: boolean;
  linesRemoved: number;
} {
  const lines = output.split('\n');

  if (lines.length <= MAX_OUTPUT_LINES && output.length <= MAX_OUTPUT_BYTES) {
    return { text: output, truncated: false, linesRemoved: 0 };
  }

  // Keep first 100 and last 400 lines (show beginning for context, end for results)
  const headLines = 100;
  const tailLines = 400;

  if (lines.length > MAX_OUTPUT_LINES) {
    const head = lines.slice(0, headLines);
    const tail = lines.slice(-tailLines);
    const removed = lines.length - headLines - tailLines;

    return {
      text: [...head, `\n... ${removed} lines omitted ...\n`, ...tail].join('\n'),
      truncated: true,
      linesRemoved: removed,
    };
  }

  // Byte limit hit - truncate and note it
  return {
    text: output.slice(0, MAX_OUTPUT_BYTES),
    truncated: true,
    linesRemoved: 0,
  };
}

async function runShell(params: any, _content: string | undefined): Promise<string> {
  const {
    command,
    action = 'exec',
    session = 'artie-main',
    pane = 0,
    cwd = '/workspace',
    timeout = 30000,
    direction = 'horizontal',
    lines = 100,
  } = params as ShellParams;

  const target = `${session}:${pane}`;

  try {
    switch (action) {
      case 'exec': {
        let execCommand = command;

        // Markdown code block magic - write file from fenced code
        if (_content && _content.includes('```')) {
          const extracted = extractCodeFromMarkdown(_content);
          if (extracted) {
            if (hasNestedHeredoc(extracted.code)) {
              return `Error: Can't use markdown fence for code containing heredoc (<<).
Use an explicit heredoc in your command instead.`;
            }

            const targetPath = command || '/workspace/generated-file';
            const delimiter = 'MARKDOWN_EOF_' + Date.now();
            execCommand = `cat > ${targetPath} << '${delimiter}'\n${extracted.code}\n${delimiter}`;
            logger.info(`Writing markdown block to: ${targetPath}`);
          }
        }

        if (!execCommand) {
          return `Error: Missing command. Usage: action="exec" command="your command here"`;
        }

        logger.info(`Executing: ${execCommand.slice(0, 100)}...`);

        // Get pwd first so we can show context
        let actualCwd = cwd;
        try {
          const { stdout: pwdOut } = await execInContainer('pwd');
          actualCwd = pwdOut.trim() || cwd;
        } catch {
          // Use default cwd
        }

        const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
        // SECURITY: pass secrets by NAME only (-e VAR, no =value). Docker pulls
        // the values from this process's env (passed as env below), so the token
        // values never appear in the command string — which gets logged on failure.
        const dockerCommand = `docker exec -w ${cwd} -e GITHUB_TOKEN -e OPENAI_API_KEY ${containerName} /bin/bash -c ${JSON.stringify(execCommand)}`;

        const { stdout, stderr } = await execAsync(dockerCommand, {
          timeout,
          maxBuffer: 1024 * 1024 * 5,
          env: process.env,
        });

        // Truncate if needed
        const truncatedStdout = truncateOutput(stdout.trim());
        const truncatedStderr = truncateOutput(stderr.trim());

        logger.info(`Command completed (${stdout.length + stderr.length} bytes)`);

        // Return terminal-native output
        return formatTerminalOutput({
          command: execCommand,
          stdout: truncatedStdout.text,
          stderr: truncatedStderr.text,
          exitCode: 0,
          cwd: actualCwd,
          truncated: truncatedStdout.truncated || truncatedStderr.truncated,
          truncatedLines: truncatedStdout.linesRemoved + truncatedStderr.linesRemoved,
        });
      }

      case 'send': {
        if (!command) {
          return `Error: Missing command for tmux send. Usage: action="send" session="name" command="..."`;
        }

        logger.info(`Sending to ${target}: ${command}`);
        await ensureSession(session, cwd);

        const escapedCommand = command.replace(/"/g, '\\"');
        await execInContainer(`tmux send-keys -t ${target} "${escapedCommand}" Enter`, timeout);
        await delay(100);

        // Return simple confirmation
        return `Sent to ${target}: ${command}
Use action="read_pane" session="${session}" to see output.`;
      }

      case 'read': {
        logger.info(`Reading from ${target}`);
        await ensureSession(session, cwd);

        const { stdout } = await execInContainer(
          `tmux capture-pane -t ${target} -p -S -${lines}`,
          timeout
        );

        // Get current directory in the pane
        let paneCwd = '/workspace';
        try {
          const { stdout: cwdOut } = await execInContainer(
            `tmux display-message -t ${target} -p '#{pane_current_path}'`
          );
          paneCwd = cwdOut.trim() || '/workspace';
        } catch {
          // Use default
        }

        const output = stdout.trim();
        const truncated = truncateOutput(output);

        // Return like looking at a terminal screen
        return `--- ${target} ---
${truncated.text}
${truncated.truncated ? `[...truncated...]` : ''}
[${paneCwd}]`;
      }

      case 'split': {
        if (!command) {
          return `Error: Missing command for split. Usage: action="split" session="name" command="..."`;
        }

        logger.info(`Splitting ${target} ${direction}`);
        await ensureSession(session, cwd);

        const splitFlag = direction === 'horizontal' ? '-h' : '-v';
        const escapedCommand = command.replace(/"/g, '\\"');

        const { stdout } = await execInContainer(
          `tmux split-window ${splitFlag} -t ${target} -c ${cwd} -P -F '#{pane_index}' "${escapedCommand}"`,
          timeout
        );

        const newPane = stdout.trim();
        return `Split ${target} -> new pane ${session}:${newPane}
Running: ${command}`;
      }

      case 'list': {
        logger.info(`Listing tmux sessions`);

        try {
          const { stdout: sessionList } = await execInContainer(
            `tmux list-sessions -F '#{session_name}: #{session_windows} window(s)'`,
            timeout
          );

          if (!sessionList.trim()) {
            return `No active tmux sessions.
Start one with: action="send" session="mywork" command="..."`;
          }

          // Get pane details for each session
          const sessions = sessionList.trim().split('\n');
          const details: string[] = ['Active sessions:'];

          for (const sess of sessions) {
            const sessionName = sess.split(':')[0];
            details.push(`\n${sess}`);

            try {
              const { stdout: paneList } = await execInContainer(
                `tmux list-panes -t ${sessionName} -F '  pane #{pane_index}: #{pane_current_path}'`
              );
              details.push(paneList.trim());
            } catch {
              // Skip pane details on error
            }
          }

          return details.join('\n');
        } catch (error: any) {
          if (error.message.includes('no server running')) {
            return `No active tmux sessions.
Start one with: action="send" session="mywork" command="..."`;
          }
          throw error;
        }
      }

      default:
        return `Unknown action: ${action}
Available: exec, send, read_pane, split, list_panes`;
    }
  } catch (error: any) {
    const isTimeout = error.killed && error.signal === 'SIGTERM';

    logger.error(`Shell failed:`, { action, command, error: error.message });

    // Return errors as terminal output too
    if (isTimeout) {
      return `$ ${command || '(no command)'}
[timed out after ${timeout}ms]
[${cwd}]`;
    }

    // Include any partial output on failure
    const stdout = error.stdout?.trim() || '';
    const stderr = error.stderr?.trim() || '';
    const output = [stdout, stderr].filter(Boolean).join('\n');

    return `$ ${command || '(no command)'}
${output}
${error.message}
[exit ${error.code || 1}]
[${cwd}]`;
  }
}

// =====================================================================================
// edit: read_file, replace, insert, delete (was the `edit` tool)
//
// Surgical file editing like Claude Code's Edit tool. LLMs are bad at rewriting whole files
// but great at specifying "replace X with Y". Returns terminal-native output (diffs,
// confirmations), not JSON.
// =====================================================================================

interface EditParams {
  action: 'replace' | 'insert' | 'delete' | 'read';
  file: string;
  old_string?: string;
  new_string?: string;
  line?: number;
  replace_all?: boolean;
}

// Execute in sandbox container
async function editExecInContainer(command: string, timeout: number = 30000) {
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
    const { stdout } = await editExecInContainer(command);
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
    const { stdout } = await editExecInContainer(command);
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
    const { stdout } = await editExecInContainer(command);
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
  await editExecInContainer(`cp "${file}" "${backupFile}"`);

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
    await editExecInContainer(`node -e ${JSON.stringify(script)}`);
  } catch (error: any) {
    // Restore backup on failure
    await editExecInContainer(`mv "${backupFile}" "${file}"`);
    if (error.stderr?.includes('STRING_NOT_FOUND')) {
      throw new Error(`String not found in ${file}`);
    }
    throw error;
  }

  // Generate diff
  const { stdout: diff } = await editExecInContainer(`diff -u "${backupFile}" "${file}" || true`);

  // Find which lines changed
  const linesChanged = await findLineNumbers(file, newString);

  // Cleanup
  await editExecInContainer(`rm -f "${backupFile}" "${tempFile}"`);

  return { linesChanged, diff };
}

async function runEdit(params: any, _content: string | undefined): Promise<string> {
  const {
    action = 'read',
    file,
    old_string,
    new_string,
    line,
    replace_all = false,
  } = params as EditParams;

  if (!file) {
    return `Error: file parameter required. Usage: action="read_file" file="/workspace/yourfile.js"`;
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
        await editExecInContainer(`sed -i '${lineNum}i\\${escaped}' "${file}"`);

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
        const toDelete = await editExecInContainer(`sed -n '${range}p' "${file}"`);

        // Delete the line(s)
        await editExecInContainer(`sed -i '${range}d' "${file}"`);

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
Available: read_file, replace, insert, delete`;
    }
  } catch (error: any) {
    logger.error(`Edit failed:`, { action, file, error: error.message });
    return `Error editing ${file}: ${error.message}`;
  }
}

// =====================================================================================
// git: git_status, git_diff, git_log, git_branch, git_show, git_blame (was the `git` tool)
//
// Version-control awareness. Read-only; commits go through exec with git commands.
// Returns terminal-native output - diffs, logs, status as you'd see them.
// =====================================================================================

interface GitParams {
  action: 'status' | 'diff' | 'log' | 'branch' | 'show' | 'blame';
  path?: string;
  file?: string;
  ref?: string;
  count?: number;
}

// Execute in sandbox container
async function gitExecInContainer(command: string, timeout: number = 30000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec -w /workspace ${containerName} /bin/bash -c ${JSON.stringify(command)}`;

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 5,
    env: process.env,
  });
}

// Truncate long output intelligently
function truncateGitOutput(
  output: string,
  maxLines: number = 100
): { text: string; truncated: boolean } {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return { text: output, truncated: false };
  }

  // Keep first 60 and last 40 lines
  const head = lines.slice(0, 60);
  const tail = lines.slice(-40);
  const removed = lines.length - 100;

  return {
    text: [...head, `\n... ${removed} lines omitted ...\n`, ...tail].join('\n'),
    truncated: true,
  };
}

async function runGit(params: any, _content: string | undefined): Promise<string> {
  const {
    action = 'status',
    path: _path = '/workspace',
    file,
    ref,
    count = 10,
  } = params as GitParams;

  logger.info(`Git: ${action}${file ? ` ${file}` : ''}${ref ? ` (${ref})` : ''}`);

  try {
    switch (action) {
      case 'status': {
        // Comprehensive status like I see it
        const { stdout: status } = await gitExecInContainer('git status');
        const { stdout: branch } = await gitExecInContainer('git branch --show-current');

        // Get short stat of changes
        let shortStat = '';
        try {
          const { stdout } = await gitExecInContainer('git diff --shortstat');
          shortStat = stdout.trim();
        } catch {
          // No changes
        }

        const lines = [`Branch: ${branch.trim()}`, '', status.trim()];

        if (shortStat) {
          lines.push('', `Summary: ${shortStat}`);
        }

        return lines.join('\n');
      }

      case 'diff': {
        let command = 'git diff --color=never';

        if (ref) {
          command = `git diff --color=never ${ref}`;
        }

        if (file) {
          command += ` -- ${file}`;
        }

        const { stdout } = await gitExecInContainer(command);

        if (!stdout.trim()) {
          return file
            ? `No changes in ${file}`
            : ref
              ? `No differences for ${ref}`
              : 'No unstaged changes';
        }

        const truncated = truncateGitOutput(stdout.trim(), 150);
        return truncated.truncated ? `${truncated.text}\n[diff truncated]` : truncated.text;
      }

      case 'log': {
        // Pretty log format like I like to see it
        let command = `git log --oneline --decorate -${count}`;

        if (file) {
          command += ` -- ${file}`;
        }

        const { stdout: oneline } = await gitExecInContainer(command);

        // Also get more detailed recent commits
        const { stdout: detailed } = await gitExecInContainer(
          `git log --format="%h %s%n  Author: %an <%ae>%n  Date: %ar%n" -3`
        );

        const lines = ['Recent commits:', '', oneline.trim()];

        if (count <= 10) {
          lines.push('', 'Details (last 3):', detailed.trim());
        }

        return lines.join('\n');
      }

      case 'branch': {
        const { stdout: branches } = await gitExecInContainer('git branch -vv');
        const { stdout: current } = await gitExecInContainer('git branch --show-current');

        // Also check for remote branches
        let remotes = '';
        try {
          const { stdout } = await gitExecInContainer('git branch -r --list | head -10');
          remotes = stdout.trim();
        } catch {
          // No remotes
        }

        const lines = [`Current: ${current.trim()}`, '', 'Local branches:', branches.trim()];

        if (remotes) {
          lines.push('', 'Remote branches:', remotes);
        }

        return lines.join('\n');
      }

      case 'show': {
        const commitRef = ref || 'HEAD';
        const { stdout } = await gitExecInContainer(
          `git show --stat --format="Commit: %H%nAuthor: %an <%ae>%nDate: %ar%n%nMessage: %s%n%b" ${commitRef}`
        );

        const truncated = truncateGitOutput(stdout.trim(), 80);
        return truncated.truncated ? `${truncated.text}\n[output truncated]` : truncated.text;
      }

      case 'blame': {
        if (!file) {
          return `Error: file required for blame. Usage: action="git_blame" file="src/app.js"`;
        }

        const { stdout } = await gitExecInContainer(`git blame --date=short ${file}`);

        const truncated = truncateGitOutput(stdout.trim(), 100);
        return truncated.truncated
          ? `Blame for ${file}:\n${truncated.text}\n[output truncated]`
          : `Blame for ${file}:\n${truncated.text}`;
      }

      default:
        return `Unknown action: ${action}
Available: git_status, git_diff, git_log, git_branch, git_show, git_blame`;
    }
  } catch (error: any) {
    // Handle common git errors nicely
    if (error.stderr?.includes('not a git repository')) {
      return `Not a git repository. Initialize with: git init`;
    }
    if (error.stderr?.includes('unknown revision')) {
      return `Unknown revision: ${ref}. Check with: git log --oneline`;
    }

    logger.error(`Git failed:`, { action, error: error.message });
    return `Git error: ${error.message}`;
  }
}

// =====================================================================================
// search: find_files, grep, search (was the dev `search` tool)
//
// Fast file finding and content search, modeled after Claude Code's Glob and Grep tools.
// =====================================================================================

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
async function searchExecInContainer(command: string, timeout: number = 30000) {
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
    const { stdout } = await searchExecInContainer(command);
    const files = stdout.trim().split('\n').filter(Boolean);

    // If fd fails, fallback to find
    if (files.length === 0) {
      const fallback = `find ${basePath} -type f -name '*${pattern}*' 2>/dev/null | head -${limit}`;
      const { stdout: fallbackOut } = await searchExecInContainer(fallback);
      return fallbackOut.trim().split('\n').filter(Boolean);
    }

    return files;
  } catch (_error) {
    // Fallback to find
    const fallback = `find ${basePath} -type f -name '*${pattern}*' 2>/dev/null | head -${limit}`;
    try {
      const { stdout } = await searchExecInContainer(fallback);
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
    const { stdout } = await searchExecInContainer(command);
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

      const { stdout } = await searchExecInContainer(grepCmd);
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

async function runSearch(params: any, _content: string | undefined): Promise<string> {
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
    return `Error: pattern required. Usage: action="find_files" pattern="*.ts"`;
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
Available: find_files, grep, search`;
    }
  } catch (error: any) {
    logger.error(`Search failed:`, { action, pattern, error: error.message });
    return `Error searching: ${error.message}`;
  }
}

// =====================================================================================
// The one registered tool: canonical action → (section runner, the action it knew)
// =====================================================================================

type SectionRunner = (params: any, content: string | undefined) => Promise<string>;

const SANDBOX_ACTIONS: Record<string, { run: SectionRunner; inner: string }> = {
  exec: { run: runShell, inner: 'exec' },
  send: { run: runShell, inner: 'send' },
  split: { run: runShell, inner: 'split' },
  read_pane: { run: runShell, inner: 'read' },
  list_panes: { run: runShell, inner: 'list' },
  read_file: { run: runEdit, inner: 'read' },
  replace: { run: runEdit, inner: 'replace' },
  insert: { run: runEdit, inner: 'insert' },
  delete: { run: runEdit, inner: 'delete' },
  git_status: { run: runGit, inner: 'status' },
  git_diff: { run: runGit, inner: 'diff' },
  git_log: { run: runGit, inner: 'log' },
  git_branch: { run: runGit, inner: 'branch' },
  git_show: { run: runGit, inner: 'show' },
  git_blame: { run: runGit, inner: 'blame' },
  find_files: { run: runSearch, inner: 'files' },
  grep: { run: runSearch, inner: 'content' },
  search: { run: runSearch, inner: 'both' },
};

export const sandboxCapability: RegisteredCapability = {
  name: 'sandbox',
  emoji: '💻',
  supportedActions: Object.keys(SANDBOX_ACTIONS),
  description: `Your Linux laptop. A persistent Debian environment where you can do real work.

You have: git, gh (authenticated), node, npm, python3, pip, curl, jq, ripgrep, and standard Unix tools.
Your workspace is /workspace - files persist between sessions.

Output comes back as terminal text, not JSON. Read it like you're looking at a screen.

Run commands:
- exec: run anything (command="..."). Pipe freely: command="curl -s url | jq '.field' | head -5"
- send / read_pane / split / list_panes: persistent tmux sessions for background work

Edit files surgically (don't rewrite whole files):
- read_file: see a file with line numbers (file, optional line="10-25"). Always read first.
- replace: find old_string and replace with new_string (fails unless unique, or replace_all="true")
- insert: add new_string at a line; delete: remove a line or range

Git (read-only; commit with exec):
- git_status, git_diff, git_log, git_branch, git_show, git_blame

Find things:
- find_files: files by name or glob (pattern="*.ts")
- grep: search inside files (pattern, type="ts", context=3, ignore_case="true")
- search: both at once

You can build tools, write scripts, clone repos, and experiment. This is your space to be creative.`,
  requiredParams: [],
  examples: [
    '<capability name="sandbox" action="exec" command="echo hello world" />',
    '<capability name="sandbox" action="exec" command="ls -la /workspace" />',
    '<capability name="sandbox" action="exec" command="cat package.json | jq .name" />',
    '<capability name="sandbox" action="exec" command="gh repo view --json name,description" />',
    `<capability name="sandbox" action="exec" command="cat > /workspace/hello.py << 'EOF'
print('Hello from Python!')
EOF" />`,
    '<capability name="sandbox" action="send" session="dev" command="cd /workspace && npm init -y" />',
    '<capability name="sandbox" action="read_pane" session="dev" />',
    '<capability name="sandbox" action="read_file" file="/workspace/app.js" line="10-25" />',
    '<capability name="sandbox" action="replace" file="/workspace/config.js" old_string="port: 3000" new_string="port: 8080" />',
    '<capability name="sandbox" action="insert" file="/workspace/app.js" line="1" new_string="// Header comment" />',
    '<capability name="sandbox" action="delete" file="/workspace/debug.js" line="15" />',
    '<capability name="sandbox" action="git_status" />',
    '<capability name="sandbox" action="git_diff" file="src/app.js" />',
    '<capability name="sandbox" action="git_log" count="10" />',
    '<capability name="sandbox" action="git_show" ref="HEAD" />',
    '<capability name="sandbox" action="find_files" pattern="*.ts" />',
    '<capability name="sandbox" action="grep" pattern="export function" type="ts" />',
    '<capability name="sandbox" action="search" pattern="handler" type="ts" />',
  ],

  handler: async (params: any, content: string | undefined) => {
    const action = params?.action;
    const entry = SANDBOX_ACTIONS[action];
    if (!entry) {
      return `Unknown action: ${action}
Available: ${Object.keys(SANDBOX_ACTIONS).join(', ')}`;
    }
    return entry.run({ ...params, action: entry.inner }, content);
  },
};

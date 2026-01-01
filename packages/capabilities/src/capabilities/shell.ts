import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';
import { marked } from 'marked';

const execAsync = promisify(exec);

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

export const shellCapability: RegisteredCapability = {
  name: 'shell',
  emoji: '💻',
  supportedActions: ['exec', 'send', 'read', 'split', 'list'],
  description: `Your Linux laptop. A persistent Debian environment where you can do real work.

You have: git, gh (authenticated), node, npm, python3, pip, curl, jq, ripgrep, and standard Unix tools.
Your workspace is /workspace - files persist between sessions.

Output comes back as terminal text, not JSON. Read it like you're looking at a screen.

Quick patterns:
- Run anything: action="exec" command="your command"
- Pipe freely: command="curl -s url | jq '.field' | head -5"
- Write files: Use heredoc or markdown code blocks
- Background work: Use tmux sessions (action="send/read")

You can build tools, write scripts, clone repos, and experiment. This is your space to be creative.`,
  requiredParams: [],
  examples: [
    // Simple and clear examples that show the terminal-native output
    '<capability name="shell" action="exec" command="echo hello world" />',
    '<capability name="shell" action="exec" command="ls -la /workspace" />',
    '<capability name="shell" action="exec" command="cat package.json | jq .name" />',
    '<capability name="shell" action="exec" command="gh repo view --json name,description" />',

    // File writing with heredoc
    `<capability name="shell" action="exec" command="cat > /workspace/hello.py << 'EOF'
print('Hello from Python!')
EOF" />`,

    // Persistent session for stateful work
    '<capability name="shell" action="send" session="dev" command="cd /workspace && npm init -y" />',
    '<capability name="shell" action="read" session="dev" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
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
          const dockerCommand = `docker exec -w ${cwd} -e GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''} -e OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''} ${containerName} /bin/bash -c ${JSON.stringify(execCommand)}`;

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
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Return simple confirmation
          return `Sent to ${target}: ${command}
Use action="read" session="${session}" to see output.`;
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
Available: exec, send, read, split, list`;
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
  },
};

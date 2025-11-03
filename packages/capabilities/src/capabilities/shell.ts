import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

interface ShellParams {
  command?: string;
  action?: 'exec' | 'send' | 'read' | 'split' | 'list';
  session?: string;
  pane?: number;
  cwd?: string;
  timeout?: number;
  direction?: 'horizontal' | 'vertical';
  lines?: number; // For read action
}

// Helper to execute command in sandbox container
async function execInContainer(command: string, timeout: number = 30000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';

  const dockerCommand = [
    'docker', 'exec',
    '-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
    '-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
    containerName,
    '/bin/bash', '-c', command
  ].join(' ');

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 5, // 5MB buffer
    env: process.env,
  });
}

// Helper to ensure tmux session exists
async function ensureSession(session: string, cwd: string = '/workspace') {
  try {
    // Check if session exists
    await execInContainer(`tmux has-session -t ${session} 2>/dev/null`);
  } catch {
    // Session doesn't exist, create it
    logger.info(`Creating new tmux session: ${session}`);
    await execInContainer(`tmux new-session -d -s ${session} -c ${cwd}`);
  }
}

export const shellCapability: RegisteredCapability = {
  name: 'shell',
  supportedActions: ['exec', 'send', 'read', 'split', 'list'],
  description: 'Execute shell commands in a sandboxed Debian container. Artie has full access to a persistent Linux environment with git, gh, jq, curl, npm, python, and more. Supports both one-shot execution (action=exec) and persistent tmux sessions (action=send/read/split/list) for stateful workflows where directory changes and environment persist between commands.',
  requiredParams: [],

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
          // One-shot execution (original behavior)
          if (!command) {
            throw new Error('Missing required parameter "command" for action=exec');
          }

          logger.info(`🖥️  Executing one-shot: ${command}`);

          const dockerCommand = [
            'docker', 'exec',
            '-w', cwd,
            '-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
            '-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
            process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox',
            '/bin/bash', '-c', command
          ].join(' ');

          const { stdout, stderr } = await execAsync(dockerCommand, {
            timeout,
            maxBuffer: 1024 * 1024 * 5,
            env: process.env,
          });

          logger.info(`✅ Command completed (${stdout.length + stderr.length} bytes)`);

          return JSON.stringify({
            success: true,
            data: {
              action: 'exec',
              command,
              cwd,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exit_code: 0,
            },
          });
        }

        case 'send': {
          // Send command to tmux session (persistent)
          if (!command) {
            throw new Error('Missing required parameter "command" for action=send');
          }

          logger.info(`📤 Sending to ${target}: ${command}`);

          await ensureSession(session, cwd);

          // Send the command to the tmux pane
          const escapedCommand = command.replace(/"/g, '\\"');
          await execInContainer(`tmux send-keys -t ${target} "${escapedCommand}" Enter`, timeout);

          // Wait a brief moment for command to start
          await new Promise(resolve => setTimeout(resolve, 100));

          logger.info(`✅ Command sent to ${target}`);

          return JSON.stringify({
            success: true,
            data: {
              action: 'send',
              command,
              session,
              pane,
              message: `Command sent to ${target}. Use action=read to see output.`,
            },
          });
        }

        case 'read': {
          // Read output from tmux pane
          logger.info(`📖 Reading from ${target} (last ${lines} lines)`);

          await ensureSession(session, cwd);

          // Capture pane output
          const { stdout } = await execInContainer(
            `tmux capture-pane -t ${target} -p -S -${lines}`,
            timeout
          );

          logger.info(`✅ Read ${stdout.length} bytes from ${target}`);

          return JSON.stringify({
            success: true,
            data: {
              action: 'read',
              session,
              pane,
              output: stdout.trim(),
              lines_requested: lines,
            },
          });
        }

        case 'split': {
          // Split pane
          if (!command) {
            throw new Error('Missing required parameter "command" for action=split. Specify the command to run in the new pane.');
          }

          logger.info(`✂️  Splitting ${target} ${direction}ly`);

          await ensureSession(session, cwd);

          const splitFlag = direction === 'horizontal' ? '-h' : '-v';
          const escapedCommand = command.replace(/"/g, '\\"');

          // Split and run command in new pane
          const { stdout } = await execInContainer(
            `tmux split-window ${splitFlag} -t ${target} -c ${cwd} -P -F '#{pane_index}' "${escapedCommand}"`,
            timeout
          );

          const newPane = stdout.trim();
          logger.info(`✅ Created new pane: ${session}:${newPane}`);

          return JSON.stringify({
            success: true,
            data: {
              action: 'split',
              session,
              original_pane: pane,
              new_pane: parseInt(newPane),
              direction,
              command,
            },
          });
        }

        case 'list': {
          // List sessions and panes
          logger.info(`📋 Listing tmux sessions and panes`);

          let sessions: any[] = [];
          try {
            const { stdout: sessionList } = await execInContainer(
              `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}'`,
              timeout
            );

            sessions = sessionList.trim().split('\n').filter(Boolean).map(line => {
              const [name, windows, created] = line.split('|');
              return { name, windows: parseInt(windows), created };
            });

            // Get panes for each session
            for (const sess of sessions) {
              const { stdout: paneList } = await execInContainer(
                `tmux list-panes -t ${sess.name} -F '#{pane_index}|#{pane_current_path}|#{pane_width}x#{pane_height}|#{pane_title}'`,
                timeout
              );

              sess.panes = paneList.trim().split('\n').filter(Boolean).map(line => {
                const [index, path, size, title] = line.split('|');
                return { index: parseInt(index), path, size, title };
              });
            }
          } catch (error: any) {
            // No sessions exist
            if (error.message.includes('no server running')) {
              sessions = [];
            } else {
              throw error;
            }
          }

          logger.info(`✅ Found ${sessions.length} session(s)`);

          return JSON.stringify({
            success: true,
            data: {
              action: 'list',
              sessions,
            },
          });
        }

        default:
          throw new Error(`Unknown action: ${action}. Supported actions: exec, send, read, split, list`);
      }
    } catch (error: any) {
      const isTimeout = error.killed && error.signal === 'SIGTERM';

      logger.error(`❌ Shell command failed:`, {
        action,
        command,
        session,
        pane,
        error: error.message,
        timeout: isTimeout,
      });

      return JSON.stringify({
        success: false,
        error: isTimeout
          ? `Command timed out after ${timeout}ms`
          : error.message,
        data: {
          action,
          command,
          session,
          pane,
          stdout: error.stdout?.trim() || '',
          stderr: error.stderr?.trim() || '',
          exit_code: error.code || 1,
        },
      });
    }
  },
};

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
  description:
    'Execute shell commands in a sandboxed Debian container. Artie has full access to a persistent Linux environment with git, gh, jq, curl, npm, python, and more. Supports both one-shot execution (action=exec) and persistent tmux sessions (action=send/read/split/list) for stateful workflows where directory changes and environment persist between commands. Use Unix patterns (cat, heredoc, sed, grep) for file operations - results are returned but NOT echoed to Discord when using action=exec.',
  requiredParams: [],
  examples: [
    // One-shot execution (simple commands)
    '<capability name="shell" action="exec" command="curl -s https://api.github.com/repos/anthropics/claude-code | jq \'.stargazers_count\'"></capability>',

    // Run a Python script
    '<capability name="shell" action="exec" command="python3 -c \'import sys; print(f\\\"Python {sys.version}\\\")\'"></capability>',

    // Git operations
    '<capability name="shell" action="exec" command="cd /workspace && git clone https://github.com/user/repo.git && cd repo && ls -la"></capability>',

    // GitHub CLI (gh is authenticated)
    '<capability name="shell" action="exec" command="gh repo list anthropics --limit 5"></capability>',

    // === FILE OPERATIONS (Unix patterns) ===

    // Read a file
    '<capability name="shell" action="exec" command="cat /workspace/my-project/index.js"></capability>',

    // Read specific lines from a file
    '<capability name="shell" action="exec" command="head -n 20 /workspace/my-project/README.md"></capability>',
    '<capability name="shell" action="exec" command="tail -n 50 /workspace/my-project/server.log"></capability>',

    // Search in files (grep)
    '<capability name="shell" action="exec" command="grep -r \\\"TODO\\\" /workspace/my-project/src/"></capability>',
    '<capability name="shell" action="exec" command="grep -n \\\"function\\\" /workspace/my-project/index.js"></capability>',

    // Write a simple file (one-liner)
    '<capability name="shell" action="exec" command="echo \\\"console.log(\'hello\');\\\" > /workspace/test.js"></capability>',

    // Write multi-line file with heredoc (for code files)
    // NOTE: Use action=exec so command/content doesn\'t get sent to Discord
    `<capability name="shell" action="exec" command="cat > /workspace/my-project/app.js << 'ENDOFFILE'
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ message: 'Hello World' });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
ENDOFFILE"></capability>`,

    // Append to a file
    '<capability name="shell" action="exec" command="echo \\\"# New section\\\" >> /workspace/README.md"></capability>',

    // === FILE EDITING (sed for in-place edits) ===

    // Simple find/replace
    '<capability name="shell" action="exec" command="sed -i \\\"s/old-text/new-text/g\\\" /workspace/config.js"></capability>',

    // Replace on specific line
    '<capability name="shell" action="exec" command="sed -i \\\"10s/const/let/\\\" /workspace/app.js"></capability>',

    // Delete lines matching pattern
    '<capability name="shell" action="exec" command="sed -i \\\"/TODO/d\\\" /workspace/notes.txt"></capability>',
    '<capability name="shell" action="exec" command="sed -i \\\"/console.log/d\\\" /workspace/debug.js"></capability>',

    // Insert line after pattern
    '<capability name="shell" action="exec" command="sed -i \\\"/const express/a const cors = require(\\\\\\\"cors\\\\\\\");\\\" /workspace/server.js"></capability>',

    // Comment out lines
    '<capability name="shell" action="exec" command="sed -i \\\"s/^/\\\\/\\\\/ /\\\" /workspace/temp.js"></capability>',

    // Change port number
    '<capability name="shell" action="exec" command="sed -i \\\"s/PORT=3000/PORT=8080/g\\\" /workspace/.env"></capability>',

    // === ADVANCED: Read-Modify-Write Pattern ===

    // Use Python for complex edits
    `<capability name="shell" action="exec" command="python3 << 'PYSCRIPT'
with open('/workspace/package.json', 'r') as f:
    import json
    pkg = json.load(f)
    pkg['version'] = '2.0.0'
    pkg['scripts']['start'] = 'node index.js'
with open('/workspace/package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
print('Updated package.json')
PYSCRIPT"></capability>`,

    // Use Node.js for JSON editing
    `<capability name="shell" action="exec" command="node << 'NODESCRIPT'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('/workspace/config.json'));
config.apiUrl = 'https://api.example.com';
config.timeout = 5000;
fs.writeFileSync('/workspace/config.json', JSON.stringify(config, null, 2));
console.log('Updated config.json');
NODESCRIPT"></capability>`,

    // List directory contents
    '<capability name="shell" action="exec" command="ls -lah /workspace/my-project/"></capability>',
    '<capability name="shell" action="exec" command="find /workspace/my-project -name \'*.js\' -type f"></capability>',

    // Check if file exists
    '<capability name="shell" action="exec" command="test -f /workspace/package.json && echo \\\"exists\\\" || echo \\\"not found\\\""></capability>',

    // Create directory
    '<capability name="shell" action="exec" command="mkdir -p /workspace/my-project/src/components"></capability>',

    // Copy/move files
    '<capability name="shell" action="exec" command="cp /workspace/template.js /workspace/my-project/index.js"></capability>',
    '<capability name="shell" action="exec" command="mv /workspace/old-name.js /workspace/new-name.js"></capability>',

    // Delete files (careful!)
    '<capability name="shell" action="exec" command="rm /workspace/temp-file.txt"></capability>',
    '<capability name="shell" action="exec" command="rm -rf /workspace/old-project/"></capability>',

    // === PERSISTENT SESSION EXAMPLES ===

    // Persistent session - send command
    '<capability name="shell" action="send" session="artie-main" command="cd /workspace && mkdir my-project && cd my-project"></capability>',

    // Read output from persistent session
    '<capability name="shell" action="read" session="artie-main" lines="50"></capability>',

    // List all sessions and panes
    '<capability name="shell" action="list"></capability>',

    // Split pane to run parallel command
    '<capability name="shell" action="split" session="artie-main" direction="vertical" command="htop"></capability>',

    // Multi-step workflow example
    `<capability name="shell" action="send" session="artie-main" command="cd /workspace && echo 'Hello from Artie!' > test.txt"></capability>
<capability name="shell" action="send" session="artie-main" command="cat test.txt"></capability>
<capability name="shell" action="read" session="artie-main" lines="20"></capability>`,
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
          // One-shot execution (original behavior)
          if (!command) {
            throw new Error('Missing required parameter "command" for action=exec');
          }

          logger.info(`🖥️  Executing one-shot: ${command}`);

          const dockerCommand = [
            'docker',
            'exec',
            '-w',
            cwd,
            '-e',
            `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
            '-e',
            `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
            process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox',
            '/bin/bash',
            '-c',
            command,
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
          await new Promise((resolve) => setTimeout(resolve, 100));

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
            throw new Error(
              'Missing required parameter "command" for action=split. Specify the command to run in the new pane.'
            );
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

            sessions = sessionList
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const [name, windows, created] = line.split('|');
                return { name, windows: parseInt(windows), created };
              });

            // Get panes for each session
            for (const sess of sessions) {
              const { stdout: paneList } = await execInContainer(
                `tmux list-panes -t ${sess.name} -F '#{pane_index}|#{pane_current_path}|#{pane_width}x#{pane_height}|#{pane_title}'`,
                timeout
              );

              sess.panes = paneList
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => {
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
          throw new Error(
            `Unknown action: ${action}. Supported actions: exec, send, read, split, list`
          );
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
        error: isTimeout ? `Command timed out after ${timeout}ms` : error.message,
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

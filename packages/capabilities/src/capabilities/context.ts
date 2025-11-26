import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

/**
 * Context capability - situational awareness
 *
 * Know where you are and what's happening. This is like the env info
 * I get at the start of conversations - crucial for making good decisions.
 *
 * Gives Artie a snapshot of the current state:
 * - Where am I? (directory, git branch)
 * - What's here? (files, structure)
 * - What changed recently?
 * - What's running?
 */

interface ContextParams {
  action: 'where' | 'what' | 'recent' | 'running' | 'full';
  path?: string;
}

// Execute in sandbox container
async function execInContainer(command: string, timeout: number = 10000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec -w /workspace ${containerName} /bin/bash -c ${JSON.stringify(command)}`;

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
}

// Safe exec that returns empty string on error
async function safeExec(command: string): Promise<string> {
  try {
    const { stdout } = await execInContainer(command);
    return stdout.trim();
  } catch {
    return '';
  }
}

export const contextCapability: RegisteredCapability = {
  name: 'context',
  emoji: '🧭',
  supportedActions: ['where', 'what', 'recent', 'running', 'full'],
  description: `Situational awareness. Know where you are and what's happening.

Actions:
- where: Current directory, git branch, basic orientation
- what: What's in the current directory (files, structure)
- recent: Recently modified files, recent git activity
- running: What processes are running (node, python, etc.)
- full: Everything above combined

Start complex tasks with context. Know where you are.`,
  requiredParams: [],
  examples: [
    // Quick orientation
    '<capability name="context" action="where" />',

    // What's here
    '<capability name="context" action="what" />',
    '<capability name="context" action="what" path="/workspace/src" />',

    // Recent activity
    '<capability name="context" action="recent" />',

    // What's running
    '<capability name="context" action="running" />',

    // Full situational awareness
    '<capability name="context" action="full" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const { action = 'where', path = '/workspace' } = params as ContextParams;

    logger.info(`Context: ${action}${path !== '/workspace' ? ` (${path})` : ''}`);

    try {
      switch (action) {
        case 'where': {
          // Basic orientation
          const pwd = await safeExec('pwd');
          const branch = await safeExec('git branch --show-current 2>/dev/null');
          const hostname = await safeExec('hostname');
          const date = await safeExec('date "+%Y-%m-%d %H:%M"');

          const lines = [
            `📍 ${pwd || '/workspace'}`,
            branch ? `🌿 Branch: ${branch}` : '(not a git repo)',
            `🖥️  ${hostname}`,
            `📅 ${date}`,
          ];

          // Quick git status summary
          const gitStatus = await safeExec('git status --porcelain 2>/dev/null | wc -l');
          if (gitStatus && parseInt(gitStatus) > 0) {
            lines.push(`📝 ${gitStatus} uncommitted changes`);
          }

          return lines.join('\n');
        }

        case 'what': {
          // What's in the directory
          const targetPath = path || '/workspace';

          // List with details
          const listing = await safeExec(`ls -la ${targetPath} | head -30`);

          // Count by type
          const fileCount = await safeExec(`find ${targetPath} -maxdepth 1 -type f | wc -l`);
          const dirCount = await safeExec(`find ${targetPath} -maxdepth 1 -type d | wc -l`);

          // Detect project type
          const projectIndicators: string[] = [];
          if (await safeExec(`test -f ${targetPath}/package.json && echo yes`)) {
            const pkgName = await safeExec(`cat ${targetPath}/package.json | grep '"name"' | head -1`);
            projectIndicators.push(`Node.js project${pkgName ? `: ${pkgName.match(/"name":\s*"([^"]+)"/)?.[1] || ''}` : ''}`);
          }
          if (await safeExec(`test -f ${targetPath}/requirements.txt && echo yes`)) {
            projectIndicators.push('Python project');
          }
          if (await safeExec(`test -f ${targetPath}/Cargo.toml && echo yes`)) {
            projectIndicators.push('Rust project');
          }
          if (await safeExec(`test -f ${targetPath}/go.mod && echo yes`)) {
            projectIndicators.push('Go project');
          }

          const lines = [`Contents of ${targetPath}:`, listing];

          lines.push('', `${fileCount} files, ${parseInt(dirCount) - 1} directories`);

          if (projectIndicators.length > 0) {
            lines.push('', `Project type: ${projectIndicators.join(', ')}`);
          }

          return lines.join('\n');
        }

        case 'recent': {
          // Recently modified files
          const recentFiles = await safeExec(
            'find /workspace -type f -mmin -60 -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -15'
          );

          // Recent git commits
          const recentCommits = await safeExec(
            'git log --oneline -5 2>/dev/null'
          );

          // Recent git activity
          const gitActivity = await safeExec(
            'git diff --stat HEAD~3 2>/dev/null | tail -5'
          );

          const lines = ['Recent activity:'];

          if (recentFiles) {
            lines.push('', 'Files modified in last hour:');
            recentFiles.split('\n').forEach(f => {
              lines.push(`  ${f.replace('/workspace/', '')}`);
            });
          } else {
            lines.push('', 'No files modified in last hour');
          }

          if (recentCommits) {
            lines.push('', 'Recent commits:');
            lines.push(recentCommits);
          }

          if (gitActivity) {
            lines.push('', 'Recent changes (last 3 commits):');
            lines.push(gitActivity);
          }

          return lines.join('\n');
        }

        case 'running': {
          // What processes are running
          const nodeProcs = await safeExec('pgrep -a node 2>/dev/null | head -5');
          const pythonProcs = await safeExec('pgrep -a python 2>/dev/null | head -5');
          const tmuxSessions = await safeExec('tmux list-sessions 2>/dev/null');

          const lines = ['Running processes:'];

          if (nodeProcs) {
            lines.push('', 'Node.js:', nodeProcs);
          }

          if (pythonProcs) {
            lines.push('', 'Python:', pythonProcs);
          }

          if (tmuxSessions) {
            lines.push('', 'Tmux sessions:', tmuxSessions);
          }

          // Port listeners
          const ports = await safeExec('ss -tlnp 2>/dev/null | grep LISTEN | head -10');
          if (ports) {
            lines.push('', 'Listening ports:', ports);
          }

          if (lines.length === 1) {
            lines.push('', 'No notable processes running');
          }

          return lines.join('\n');
        }

        case 'full': {
          // Everything combined - full situational awareness
          const sections: string[] = [];

          // Where
          const pwd = await safeExec('pwd');
          const branch = await safeExec('git branch --show-current 2>/dev/null');
          const date = await safeExec('date "+%Y-%m-%d %H:%M"');
          sections.push(`=== LOCATION ===\n📍 ${pwd}\n🌿 ${branch || '(no git)'}\n📅 ${date}`);

          // Git status summary
          const gitStatus = await safeExec('git status --short 2>/dev/null | head -10');
          if (gitStatus) {
            sections.push(`=== GIT STATUS ===\n${gitStatus}`);
          }

          // Directory structure (top level)
          const structure = await safeExec('ls -1 /workspace | head -15');
          sections.push(`=== WORKSPACE ===\n${structure}`);

          // Recent files
          const recentFiles = await safeExec(
            'find /workspace -type f -mmin -30 -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -8'
          );
          if (recentFiles) {
            const formatted = recentFiles.split('\n').map(f => f.replace('/workspace/', '')).join('\n');
            sections.push(`=== RECENTLY MODIFIED ===\n${formatted}`);
          }

          // Running processes (brief)
          const procs = await safeExec('pgrep -a "node|python" 2>/dev/null | head -3');
          if (procs) {
            sections.push(`=== RUNNING ===\n${procs}`);
          }

          return sections.join('\n\n');
        }

        default:
          return `Unknown action: ${action}
Available: where, what, recent, running, full`;
      }
    } catch (error: any) {
      logger.error(`Context failed:`, { action, error: error.message });
      return `Context error: ${error.message}`;
    }
  },
};

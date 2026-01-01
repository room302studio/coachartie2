import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

/**
 * Git capability - version control awareness
 *
 * One of my favorite tools. Understanding git state is crucial for
 * code work: what branch am I on, what changed, what's the history.
 *
 * Returns terminal-native output - diffs, logs, status as you'd see them.
 */

interface GitParams {
  action: 'status' | 'diff' | 'log' | 'branch' | 'show' | 'blame';
  path?: string;
  file?: string;
  ref?: string;
  count?: number;
}

// Execute in sandbox container
async function execInContainer(command: string, timeout: number = 30000) {
  const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';
  const dockerCommand = `docker exec -w /workspace ${containerName} /bin/bash -c ${JSON.stringify(command)}`;

  return await execAsync(dockerCommand, {
    timeout,
    maxBuffer: 1024 * 1024 * 5,
    env: process.env,
  });
}

// Truncate long output intelligently
function truncateOutput(
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

export const gitCapability: RegisteredCapability = {
  name: 'git',
  emoji: '📚',
  supportedActions: ['status', 'diff', 'log', 'branch', 'show', 'blame'],
  description: `Git awareness for your laptop. Understand the state of code: what changed, history, branches.

Actions:
- status: Working tree status (what's modified, staged, untracked)
- diff: Show changes (staged, unstaged, or between refs)
- log: Commit history with messages
- branch: List branches, show current
- show: Display a specific commit
- blame: Who changed what line

Read-only operations. For committing, use shell with git commands.`,
  requiredParams: [],
  examples: [
    // Status - most common
    '<capability name="git" action="status" />',

    // Diff variations
    '<capability name="git" action="diff" />',
    '<capability name="git" action="diff" file="src/app.js" />',
    '<capability name="git" action="diff" ref="HEAD~3" />',
    '<capability name="git" action="diff" ref="main..feature" />',

    // Log
    '<capability name="git" action="log" count="10" />',
    '<capability name="git" action="log" file="src/app.js" />',

    // Branch
    '<capability name="git" action="branch" />',

    // Show specific commit
    '<capability name="git" action="show" ref="HEAD" />',
    '<capability name="git" action="show" ref="abc123" />',

    // Blame
    '<capability name="git" action="blame" file="src/app.js" />',
  ],

  handler: async (params: any, _content: string | undefined) => {
    const { action = 'status', path = '/workspace', file, ref, count = 10 } = params as GitParams;

    logger.info(`Git: ${action}${file ? ` ${file}` : ''}${ref ? ` (${ref})` : ''}`);

    try {
      switch (action) {
        case 'status': {
          // Comprehensive status like I see it
          const { stdout: status } = await execInContainer('git status');
          const { stdout: branch } = await execInContainer('git branch --show-current');

          // Get short stat of changes
          let shortStat = '';
          try {
            const { stdout } = await execInContainer('git diff --shortstat');
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

          const { stdout } = await execInContainer(command);

          if (!stdout.trim()) {
            return file
              ? `No changes in ${file}`
              : ref
                ? `No differences for ${ref}`
                : 'No unstaged changes';
          }

          const truncated = truncateOutput(stdout.trim(), 150);
          return truncated.truncated ? `${truncated.text}\n[diff truncated]` : truncated.text;
        }

        case 'log': {
          // Pretty log format like I like to see it
          let command = `git log --oneline --decorate -${count}`;

          if (file) {
            command += ` -- ${file}`;
          }

          const { stdout: oneline } = await execInContainer(command);

          // Also get more detailed recent commits
          const { stdout: detailed } = await execInContainer(
            `git log --format="%h %s%n  Author: %an <%ae>%n  Date: %ar%n" -3`
          );

          const lines = ['Recent commits:', '', oneline.trim()];

          if (count <= 10) {
            lines.push('', 'Details (last 3):', detailed.trim());
          }

          return lines.join('\n');
        }

        case 'branch': {
          const { stdout: branches } = await execInContainer('git branch -vv');
          const { stdout: current } = await execInContainer('git branch --show-current');

          // Also check for remote branches
          let remotes = '';
          try {
            const { stdout } = await execInContainer('git branch -r --list | head -10');
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
          const { stdout } = await execInContainer(
            `git show --stat --format="Commit: %H%nAuthor: %an <%ae>%nDate: %ar%n%nMessage: %s%n%b" ${commitRef}`
          );

          const truncated = truncateOutput(stdout.trim(), 80);
          return truncated.truncated ? `${truncated.text}\n[output truncated]` : truncated.text;
        }

        case 'blame': {
          if (!file) {
            return `Error: file required for blame. Usage: action="blame" file="src/app.js"`;
          }

          const { stdout } = await execInContainer(`git blame --date=short ${file}`);

          const truncated = truncateOutput(stdout.trim(), 100);
          return truncated.truncated
            ? `Blame for ${file}:\n${truncated.text}\n[output truncated]`
            : `Blame for ${file}:\n${truncated.text}`;
        }

        default:
          return `Unknown action: ${action}
Available: status, diff, log, branch, show, blame`;
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
  },
};

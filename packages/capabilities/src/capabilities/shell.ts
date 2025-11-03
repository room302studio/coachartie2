import { logger } from '@coachartie/shared';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RegisteredCapability } from '../services/capability-registry.js';

const execAsync = promisify(exec);

interface ShellParams {
  command: string;
  cwd?: string;
  timeout?: number;
}

export const shellCapability: RegisteredCapability = {
  name: 'shell',
  supportedActions: ['exec'],
  description: 'Execute shell commands in a sandboxed Debian container. Artie has full access to a persistent Linux environment with git, gh, jq, curl, npm, python, and more. He can install packages, clone repos, run scripts - it\'s his "laptop".',
  requiredParams: ['command'],

  handler: async (params: any, _content: string | undefined) => {
    const { command, cwd = '/workspace', timeout = 30000 } = params as ShellParams;

    if (!command) {
      throw new Error('Missing required parameter "command". Example: <capability name="shell" command="gh repo list" />');
    }

    logger.info(`🖥️  Executing in sandbox: ${command}`);

    try {
      // Execute command in the sandbox container
      const containerName = process.env.SANDBOX_CONTAINER_NAME || 'coachartie-sandbox';

      // Build docker exec command
      const dockerCommand = [
        'docker', 'exec',
        '-w', cwd,  // Set working directory
        '-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,  // Pass through env vars
        '-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}`,
        containerName,
        '/bin/bash', '-c', command
      ].join(' ');

      const { stdout, stderr } = await execAsync(dockerCommand, {
        timeout,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
        env: process.env,
      });

      logger.info(`✅ Command completed (${stdout.length + stderr.length} bytes output)`);

      return JSON.stringify({
        success: true,
        data: {
          command,
          cwd,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: 0,
        },
      });
    } catch (error: any) {
      // Command failed or timed out
      const isTimeout = error.killed && error.signal === 'SIGTERM';

      logger.error(`❌ Sandbox command failed:`, {
        command,
        error: error.message,
        timeout: isTimeout,
      });

      return JSON.stringify({
        success: false,
        error: isTimeout
          ? `Command timed out after ${timeout}ms`
          : error.message,
        data: {
          command,
          cwd,
          stdout: error.stdout?.trim() || '',
          stderr: error.stderr?.trim() || '',
          exit_code: error.code || 1,
        },
      });
    }
  },
};

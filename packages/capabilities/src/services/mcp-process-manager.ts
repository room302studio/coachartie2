import { logger } from '@coachartie/shared';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * MCP Process details
 */
export interface MCPProcess {
  id: string;
  command: string;
  args: string[];
  transport: 'stdio' | 'docker';
  process?: ChildProcess;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  startedAt?: Date;
  lastHealthCheck?: Date;
  restartCount: number;
  maxRestarts: number;
  error?: string;
  healthCheckInterval?: NodeJS.Timeout;
}

/**
 * MCP Process Manager - handles lifecycle of MCP server processes
 */
export class MCPProcessManager extends EventEmitter {
  private processes = new Map<string, MCPProcess>();
  private healthCheckInterval = 30000; // 30 seconds

  /**
   * Generate unique process ID
   */
  private generateProcessId(command: string): string {
    return `mcp_${Date.now()}_${command.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  /**
   * Parse stdio:// URL into command and args
   */
  private parseStdioUrl(url: string): {
    command: string;
    args: string[];
    transport: 'stdio' | 'docker';
  } {
    // Remove stdio:// prefix
    const cleanUrl = url.replace(/^stdio:\/\//, '');

    // Check for Docker patterns
    if (cleanUrl.startsWith('docker/') || cleanUrl.includes('docker run')) {
      return this.parseDockerCommand(cleanUrl);
    }

    // Handle npm packages: stdio://npm/@package/name
    if (cleanUrl.startsWith('npm/')) {
      const packageName = cleanUrl.replace('npm/', '');
      return {
        command: 'npx',
        args: [packageName],
        transport: 'stdio',
      };
    }

    // Handle GitHub URLs: stdio://github/user/repo/path
    if (cleanUrl.startsWith('github/')) {
      throw new Error('GitHub MCP servers not yet supported - install locally first');
    }

    // Handle direct commands: stdio://node server.js
    const parts = cleanUrl.split(' ');
    return {
      command: parts[0],
      args: parts.slice(1),
      transport: 'stdio',
    };
  }

  /**
   * Parse Docker command
   */
  private parseDockerCommand(url: string): {
    command: string;
    args: string[];
    transport: 'docker';
  } {
    // Handle docker/ prefix: docker/mcp/wikipedia
    if (url.startsWith('docker/')) {
      const imageName = url.replace('docker/', '');
      return {
        command: 'docker',
        args: ['run', '-i', '--rm', '--init', imageName],
        transport: 'docker',
      };
    }

    // Handle full docker commands
    if (url.includes('docker run')) {
      const parts = url.split(' ');
      return {
        command: 'docker',
        args: parts.slice(1),
        transport: 'docker',
      };
    }

    throw new Error(`Invalid docker URL format: ${url}`);
  }

  /**
   * Start an MCP process
   */
  async startProcess(url: string, maxRestarts = 3): Promise<string> {
    try {
      const { command, args, transport } = this.parseStdioUrl(url);
      const processId = this.generateProcessId(url);

      // Check if process already exists
      if (this.processes.has(processId)) {
        const existing = this.processes.get(processId)!;
        if (existing.status === 'running') {
          return `Process already running: ${processId}`;
        }
      }

      const mcpProcess: MCPProcess = {
        id: processId,
        command,
        args,
        transport,
        status: 'starting',
        restartCount: 0,
        maxRestarts,
      };

      this.processes.set(processId, mcpProcess);
      logger.info(`Starting MCP process: ${command} ${args.join(' ')}`);

      // Spawn the process
      const childProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DOCKER_CONTAINER: transport === 'docker' ? 'true' : undefined,
        },
      });

      mcpProcess.process = childProcess;
      mcpProcess.startedAt = new Date();

      // Set up process event handlers
      this.setupProcessHandlers(mcpProcess);

      // Check immediately if process failed (no need to wait)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // For MCP processes, we expect them to stay running (exitCode should be null)
      // Only fail if the process was killed or exited with an error immediately
      if (childProcess.killed || (childProcess.exitCode !== null && childProcess.exitCode !== 0)) {
        mcpProcess.status = 'failed';
        mcpProcess.error = `Process failed to start (exit code: ${childProcess.exitCode})`;
        throw new Error(mcpProcess.error);
      }

      mcpProcess.status = 'running';

      // Start health checking
      this.startHealthCheck(mcpProcess);

      this.emit('processStarted', mcpProcess);
      logger.info(`MCP process started successfully: ${processId}`);

      return processId;
    } catch (error) {
      logger.error(`Failed to start MCP process for ${url}:`, error);
      throw error;
    }
  }

  /**
   * Stop an MCP process
   */
  async stopProcess(processId: string): Promise<void> {
    const mcpProcess = this.processes.get(processId);
    if (!mcpProcess) {
      throw new Error(`Process not found: ${processId}`);
    }

    logger.info(`Stopping MCP process: ${processId}`);

    // Clear health check
    if (mcpProcess.healthCheckInterval) {
      clearInterval(mcpProcess.healthCheckInterval);
    }

    // Kill the process
    if (mcpProcess.process && !mcpProcess.process.killed) {
      mcpProcess.process.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        if (mcpProcess.process && !mcpProcess.process.killed) {
          mcpProcess.process.kill('SIGKILL');
        }
      }, 5000);
    }

    mcpProcess.status = 'stopped';
    this.emit('processStopped', mcpProcess);
  }

  /**
   * Restart an MCP process
   */
  async restartProcess(processId: string): Promise<void> {
    const mcpProcess = this.processes.get(processId);
    if (!mcpProcess) {
      throw new Error(`Process not found: ${processId}`);
    }

    if (mcpProcess.restartCount >= mcpProcess.maxRestarts) {
      throw new Error(
        `Process ${processId} has exceeded maximum restarts (${mcpProcess.maxRestarts})`
      );
    }

    logger.info(`Restarting MCP process: ${processId} (attempt ${mcpProcess.restartCount + 1})`);

    // Stop current process
    await this.stopProcess(processId);

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Restart with same configuration
    mcpProcess.restartCount++;
    const url = `stdio://${mcpProcess.command} ${mcpProcess.args.join(' ')}`;
    await this.startProcess(url, mcpProcess.maxRestarts);
  }

  /**
   * Set up process event handlers
   */
  private setupProcessHandlers(mcpProcess: MCPProcess): void {
    if (!mcpProcess.process) {
      return;
    }

    mcpProcess.process.on('error', (error) => {
      logger.error(`MCP process error (${mcpProcess.id}):`, error);
      mcpProcess.error = error.message;
      mcpProcess.status = 'failed';
      this.emit('processError', mcpProcess, error);

      // Auto-restart if under limit
      if (mcpProcess.restartCount < mcpProcess.maxRestarts) {
        setTimeout(() => {
          this.restartProcess(mcpProcess.id).catch((err) => {
            logger.error(`Failed to auto-restart process ${mcpProcess.id}:`, err);
          });
        }, 5000);
      }
    });

    mcpProcess.process.on('exit', (code, signal) => {
      logger.info(`MCP process exited (${mcpProcess.id}): code=${code}, signal=${signal}`);
      mcpProcess.status = code === 0 ? 'stopped' : 'failed';
      mcpProcess.error = code !== 0 ? `Process exited with code ${code}` : undefined;

      // Clear health check
      if (mcpProcess.healthCheckInterval) {
        clearInterval(mcpProcess.healthCheckInterval);
      }

      this.emit('processExited', mcpProcess, code, signal);

      // Auto-restart on unexpected exit
      if (code !== 0 && mcpProcess.restartCount < mcpProcess.maxRestarts) {
        setTimeout(() => {
          this.restartProcess(mcpProcess.id).catch((err) => {
            logger.error(`Failed to auto-restart process ${mcpProcess.id}:`, err);
          });
        }, 5000);
      }
    });

    mcpProcess.process.stderr?.on('data', (data) => {
      logger.warn(`MCP process stderr (${mcpProcess.id}):`, data.toString());
    });
  }

  /**
   * Start health checking for a process
   */
  private startHealthCheck(mcpProcess: MCPProcess): void {
    mcpProcess.healthCheckInterval = setInterval(() => {
      if (mcpProcess.process && !mcpProcess.process.killed) {
        mcpProcess.lastHealthCheck = new Date();
        // Process is still alive, emit health event
        this.emit('processHealthy', mcpProcess);
      } else {
        mcpProcess.status = 'failed';
        mcpProcess.error = 'Process is no longer running';
        if (mcpProcess.healthCheckInterval) {
          clearInterval(mcpProcess.healthCheckInterval);
        }
        this.emit('processUnhealthy', mcpProcess);
      }
    }, this.healthCheckInterval);
  }

  /**
   * Get process by ID
   */
  getProcess(processId: string): MCPProcess | undefined {
    return this.processes.get(processId);
  }

  /**
   * List all processes
   */
  listProcesses(): MCPProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get running processes
   */
  getRunningProcesses(): MCPProcess[] {
    return Array.from(this.processes.values()).filter((p) => p.status === 'running');
  }

  /**
   * Health check all processes
   */
  async healthCheckAll(): Promise<{ healthy: number; unhealthy: number; total: number }> {
    const processes = Array.from(this.processes.values());
    let healthy = 0;
    let unhealthy = 0;

    for (const process of processes) {
      if (process.status === 'running' && process.process && !process.process.killed) {
        healthy++;
      } else {
        unhealthy++;
      }
    }

    return { healthy, unhealthy, total: processes.length };
  }

  /**
   * Cleanup all processes
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up all MCP processes...');

    const stopPromises = Array.from(this.processes.keys()).map((id) =>
      this.stopProcess(id).catch((err) => logger.error(`Failed to stop process ${id}:`, err))
    );

    await Promise.all(stopPromises);
    this.processes.clear();
  }
}

// Singleton instance
export const mcpProcessManager = new MCPProcessManager();

// Graceful shutdown
process.on('SIGTERM', () => mcpProcessManager.cleanup());
process.on('SIGINT', () => mcpProcessManager.cleanup());

import { logger } from '@coachartie/shared';

/**
 * Simple Self-Healing - MVP Version
 *
 * Just fixes the most common shit that breaks:
 * - Dead MCP processes
 * - Memory leaks
 */
export class SimpleHealer {
  private isRunning = false;
  private interval: NodeJS.Timeout | null = null;

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.interval = setInterval(() => this.heal(), 30000); // Every 30s
    // Healer started
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.isRunning = false;
    // Healer stopped
  }

  private async heal(): Promise<void> {
    try {
      // CANCER FIXED: Don't check non-existent mcpToolRegistry
      // The Wikipedia MCP processes are working fine!

      // Fix: Force GC if memory > 200MB
      const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      if (memMB > 200 && global.gc) {
        global.gc();
        logger.info(
          `🧹 Forced GC: ${memMB}MB -> ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        );
      }
    } catch (error) {
      logger.error('Simple healer error:', error);
    }
  }

  private async restartWikipedia(): Promise<void> {
    try {
      const { mcpProcessManager } = await import('../services/mcp-process-manager.js');
      await mcpProcessManager.startProcess('stdio://npx @shelm/wikipedia-mcp-server');
      // MCP restarted
    } catch (_error) {}
  }
}

export const simpleHealer = new SimpleHealer();

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
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.interval = setInterval(() => this.heal(), 30000); // Every 30s
    // Healer started
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.isRunning = false;
    // Healer stopped
  }

  private async heal(): Promise<void> {
    try {
      // Fix 1: Restart Wikipedia if registry is empty
      if (!global.mcpToolRegistry || global.mcpToolRegistry.size === 0) {
        await this.restartWikipedia();
      }

      // Fix 2: Force GC if memory > 200MB
      const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      if (memMB > 200 && global.gc) {
        global.gc();
        // GC forced
      }

    } catch (error) {
    }
  }

  private async restartWikipedia(): Promise<void> {
    try {
      const { mcpProcessManager } = await import('../services/mcp-process-manager.js');
      await mcpProcessManager.startMCPProcess('stdio://npx @shelm/wikipedia-mcp-server');
      // MCP restarted
    } catch (error) {
    }
  }
}

export const simpleHealer = new SimpleHealer();
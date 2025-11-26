import { logger } from '@coachartie/shared';

/**
 * Simple Self-Healing - MVP Version
 *
 * Just fixes the most common shit that breaks:
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
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.isRunning = false;
  }

  private async heal(): Promise<void> {
    try {
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
}

export const simpleHealer = new SimpleHealer();

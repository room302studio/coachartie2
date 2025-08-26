import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@coachartie/shared';

/**
 * Dead simple NDJSON logger for context alchemy
 * Logs everything, rotates weekly, Richard Stallman would be proud
 */
export class ContextLogger {
  private logDir: string;
  
  constructor() {
    this.logDir = path.join(process.cwd(), 'logs', 'context');
    this.ensureLogDir();
  }
  
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
  
  private getLogPath(userId: string): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = `${userId}_${date}.ndjson`;
    return path.join(this.logDir, filename);
  }
  
  /**
   * Log context alchemy data to user's daily file
   */
  logContext(userId: string, data: any): void {
    try {
      const logPath = this.getLogPath(userId);
      const entry = {
        timestamp: new Date().toISOString(),
        userId,
        ...data
      };
      
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(logPath, line);
    } catch (e) {
      // Logging failed? Move on, this is non-critical
    }
  }
  
  /**
   * Clean logs older than 7 days
   */
  cleanOldLogs(): void {
    try {
      const now = Date.now();
      const weekInMs = 7 * 24 * 60 * 60 * 1000;
      
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (!file.endsWith('.ndjson')) continue;
        
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > weekInMs) {
          fs.unlinkSync(filePath);
          logger.debug(`Cleaned old context log: ${file}`);
        }
      }
    } catch (e) {
      // Cleanup failed? Whatever, try again tomorrow
    }
  }
}

export const contextLogger = new ContextLogger();
import { randomUUID } from 'crypto';

/**
 * Generate a correlation ID for tracking requests across services
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Create a short correlation ID for display purposes (last 8 chars)
 */
export function getShortCorrelationId(correlationId: string): string {
  return correlationId.slice(-8);
}

/**
 * Context object for tracking correlation across async operations
 */
export class CorrelationContext {
  private static current: Map<string, string> = new Map();

  static set(key: string, correlationId: string): void {
    this.current.set(key, correlationId);
  }

  static get(key: string): string | undefined {
    return this.current.get(key);
  }

  static delete(key: string): void {
    this.current.delete(key);
  }

  static clear(): void {
    this.current.clear();
  }

  /**
   * Get correlation ID for a Discord message
   */
  static getForMessage(messageId: string): string {
    const existing = this.get(`message:${messageId}`);
    if (existing) return existing;

    const correlationId = generateCorrelationId();
    this.set(`message:${messageId}`, correlationId);
    return correlationId;
  }

  /**
   * Get correlation ID for a Discord user session
   */
  static getForUser(userId: string): string {
    const existing = this.get(`user:${userId}`);
    if (existing) return existing;

    const correlationId = generateCorrelationId();
    this.set(`user:${userId}`, correlationId);
    return correlationId;
  }

  /**
   * Clean up old correlation IDs to prevent memory leaks
   */
  static cleanup(): void {
    // Keep only recent entries (basic cleanup strategy)
    if (this.current.size > 1000) {
      const entries = Array.from(this.current.entries());
      this.current.clear();
      // Keep last 500 entries
      entries.slice(-500).forEach(([key, value]) => {
        this.current.set(key, value);
      });
    }
  }
}

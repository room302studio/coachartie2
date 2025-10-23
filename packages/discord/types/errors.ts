// Custom error types for better error handling
export class CapabilitiesError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CapabilitiesError';
  }
}

export class DiscordError extends Error {
  constructor(
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DiscordError';
  }
}

export class QueueError extends Error {
  constructor(
    message: string,
    public taskId: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

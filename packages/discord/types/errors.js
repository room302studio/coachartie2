// Basic error classes for the bot
export class DiscordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscordError';
  }
}

export class CapabilitiesError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'CapabilitiesError';
    this.status = status;
    this.details = details;
  }
}

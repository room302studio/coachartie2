export const QUEUES = {
  INCOMING_MESSAGES: 'coachartie-messages-incoming',
  CAPABILITY_PROCESSING: 'coachartie-capabilities-process',
  OUTGOING_DISCORD: 'coachartie-discord-outgoing',
  OUTGOING_SMS: 'coachartie-sms-outgoing',
  OUTGOING_EMAIL: 'coachartie-email-outgoing',
  DEAD_LETTER: 'coachartie-dlq',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

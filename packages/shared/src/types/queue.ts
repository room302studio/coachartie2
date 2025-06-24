export interface BaseQueueMessage {
  id: string;
  timestamp: Date;
  retryCount: number;
  source: 'discord' | 'sms' | 'email' | 'api' | 'capabilities';
}

export interface IncomingMessage extends BaseQueueMessage {
  userId: string;
  message: string;
  context?: Record<string, any>;
  respondTo: {
    type: 'discord' | 'sms' | 'email' | 'api';
    channelId?: string;
    phoneNumber?: string;
    emailAddress?: string;
    threadId?: string;
    apiResponseId?: string;
  };
}

export interface OutgoingMessage extends BaseQueueMessage {
  userId: string;
  message: string;
  inReplyTo: string;
  metadata?: Record<string, any>;
}

export interface CapabilityRequest extends BaseQueueMessage {
  capability: string;
  parameters: Record<string, any>;
  context: Record<string, any>;
  messageId: string;
}

export interface CapabilityResponse {
  success: boolean;
  result?: any;
  error?: string;
  messageId: string;
}
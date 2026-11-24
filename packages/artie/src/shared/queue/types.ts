interface BaseQueueMessage {
  id: string;
  timestamp: Date;
  retryCount: number;
  source: 'discord' | 'slack' | 'sms' | 'email' | 'api' | 'capabilities' | 'irc' | 'reddit';
}

export interface IncomingMessage extends BaseQueueMessage {
  userId: string;
  message: string;
  context?: Record<string, any>;
  respondTo: {
    type: 'discord' | 'slack' | 'sms' | 'email' | 'api' | 'irc' | 'reddit';
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

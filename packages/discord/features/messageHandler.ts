import { ResultAsync, ok } from 'neverthrow';
import { Message } from 'discord.js';
import { DiscordError } from '../types/errors';
import { capabilitiesClient } from '../services/capabilities';
import logger from '../logger';

// Validate the message meets our requirements
const validateMessage = async (message: Message) => {
  if (message.author.bot) {
    throw new Error('Message is from a bot');
  }
  if (!message.content.trim()) {
    throw new Error('Message is empty');
  }
  return message;
};

// Check if the message is requesting a specific task
const isTaskRequest = (message: Message): boolean => {
  const taskKeywords = ['/task', '!task', 'task:'];
  return taskKeywords.some(keyword =>
    message.content.toLowerCase().startsWith(keyword)
  );
};

// Handle task-specific requests
const handleTaskRequest = (message: Message) => {
  logger.info('Task request received', { messageId: message.id });
  return ResultAsync.fromPromise(
    message.reply('Task handling is not implemented yet'),
    error => new DiscordError('Failed to handle task', { error })
  );
};

export const handleMessage = (message: Message) => {
  return ResultAsync.fromPromise(
    validateMessage(message),
    error => new DiscordError('Message validation failed', { error })
  ).andThen(validatedMessage => {
    // Determine if this is a chat or task
    if (isTaskRequest(validatedMessage)) {
      return handleTaskRequest(validatedMessage);
    }
    return handleChatRequest(validatedMessage);
  });
};

const handleChatRequest = (message: Message) => {
  return capabilitiesClient
    .chat(message.content, message)
    .andThen(response =>
      ResultAsync.fromPromise(
        message.reply(response.message),
        error => new DiscordError('Failed to send reply', { error })
      )
    );
};

/**
 * Tests for Discord Discussion Sync Feature
 *
 * NOTE: These are unit tests for the core logic.
 * Full integration testing requires:
 * - Running Discord bot
 * - Access to Discord forums
 * - Valid GitHub token
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GitHubIntegrationService } from '../src/services/github-integration.js';
import { ConversationStateManager } from '../src/services/conversation-state.js';

describe('GitHub Integration Service', () => {
  let service: GitHubIntegrationService;

  beforeEach(() => {
    // Use fake token for testing parsing logic only
    service = new GitHubIntegrationService('fake_token_for_testing');
  });

  describe('parseRepoReference', () => {
    it('should parse owner/repo format', () => {
      const result = service.parseRepoReference('facebook/react');
      expect(result).toEqual({ owner: 'facebook', repo: 'react' });
    });

    it('should parse GitHub URL', () => {
      const result = service.parseRepoReference('https://github.com/facebook/react');
      expect(result).toEqual({ owner: 'facebook', repo: 'react' });
    });

    it('should parse GitHub URL with .git', () => {
      const result = service.parseRepoReference('https://github.com/facebook/react.git');
      expect(result).toEqual({ owner: 'facebook', repo: 'react' });
    });

    it('should return null for invalid format', () => {
      const result = service.parseRepoReference('invalid');
      expect(result).toBeNull();
    });

    it('should return null for malformed URL', () => {
      const result = service.parseRepoReference('https://example.com/repo');
      expect(result).toBeNull();
    });
  });

  describe('formatThreadAsIssue', () => {
    it('should format thread with starter message', () => {
      const mockThread = {
        threadId: '123',
        threadName: 'Bug: Login not working',
        threadTags: ['bug', 'urgent'],
        createdAt: new Date('2025-01-10'),
        ownerId: '456',
        ownerName: 'testuser',
        messageCount: 3,
        isLocked: false,
        isArchived: false,
        messages: [
          {
            messageId: '1',
            authorId: '456',
            authorName: 'testuser',
            content: 'Login button is broken on mobile',
            createdAt: new Date('2025-01-10'),
            attachments: [],
            reactions: [],
          },
        ],
        starterMessage: {
          messageId: '1',
          authorId: '456',
          authorName: 'testuser',
          content: 'Login button is broken on mobile',
          createdAt: new Date('2025-01-10'),
          attachments: [],
          reactions: [],
        },
      };

      const result = service.formatThreadAsIssue(mockThread, 'Bug Reports');

      expect(result.title).toBe('[Discord Discussion] Bug: Login not working');
      expect(result.body).toContain('Bug Reports');
      expect(result.body).toContain('testuser');
      expect(result.body).toContain('Login button is broken on mobile');
      expect(result.body).toContain('bug, urgent');
    });

    it('should handle threads with multiple messages', () => {
      const mockThread = {
        threadId: '123',
        threadName: 'Feature Request',
        threadTags: ['feature'],
        createdAt: new Date('2025-01-10'),
        ownerId: '456',
        ownerName: 'user1',
        messageCount: 5,
        isLocked: false,
        isArchived: false,
        messages: [
          {
            messageId: '1',
            authorId: '456',
            authorName: 'user1',
            content: 'Original post',
            createdAt: new Date('2025-01-10'),
            attachments: [],
            reactions: [],
          },
          {
            messageId: '2',
            authorId: '789',
            authorName: 'user2',
            content: 'Reply 1',
            createdAt: new Date('2025-01-11'),
            attachments: [],
            reactions: [],
          },
          {
            messageId: '3',
            authorId: '012',
            authorName: 'user3',
            content: 'Reply 2',
            createdAt: new Date('2025-01-12'),
            attachments: [],
            reactions: [],
          },
        ],
        starterMessage: {
          messageId: '1',
          authorId: '456',
          authorName: 'user1',
          content: 'Original post',
          createdAt: new Date('2025-01-10'),
          attachments: [],
          reactions: [],
        },
      };

      const result = service.formatThreadAsIssue(mockThread, 'Feedback');

      expect(result.body).toContain('2 replies');
      expect(result.body).toContain('user2');
      expect(result.body).toContain('user3');
    });
  });

  describe('suggestLabels', () => {
    it('should suggest bug label for bug-related content', () => {
      const mockThread = {
        threadId: '123',
        threadName: 'Login Error',
        threadTags: [],
        createdAt: new Date(),
        ownerId: '456',
        ownerName: 'user',
        messageCount: 1,
        isLocked: false,
        isArchived: false,
        messages: [],
        starterMessage: {
          messageId: '1',
          authorId: '456',
          authorName: 'user',
          content: 'I found a bug in the login system',
          createdAt: new Date(),
          attachments: [],
          reactions: [],
        },
      };

      const result = service.formatThreadAsIssue(mockThread, 'Forum');
      expect(result.labels).toContain('bug');
      expect(result.labels).toContain('discord-sync');
    });

    it('should map forum tags to GitHub labels', () => {
      const mockThread = {
        threadId: '123',
        threadName: 'Feature Idea',
        threadTags: ['feature', 'enhancement'],
        createdAt: new Date(),
        ownerId: '456',
        ownerName: 'user',
        messageCount: 1,
        isLocked: false,
        isArchived: false,
        messages: [],
        starterMessage: {
          messageId: '1',
          authorId: '456',
          authorName: 'user',
          content: 'Would be nice to have dark mode',
          createdAt: new Date(),
          attachments: [],
          reactions: [],
        },
      };

      const result = service.formatThreadAsIssue(mockThread, 'Forum');
      expect(result.labels).toContain('enhancement');
    });
  });
});

describe('Conversation State Manager', () => {
  let manager: ConversationStateManager;

  beforeEach(() => {
    manager = new ConversationStateManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('conversation lifecycle', () => {
    it('should start a new conversation', () => {
      const context = manager.startConversation('user123', 'sync-discussions', {
        forumId: 'forum1',
        step: 'awaiting_repo',
      });

      expect(context.userId).toBe('user123');
      expect(context.conversationType).toBe('sync-discussions');
      expect(context.state.forumId).toBe('forum1');
    });

    it('should retrieve an active conversation', () => {
      manager.startConversation('user123', 'sync-discussions', { test: 'data' });

      const retrieved = manager.getConversation('user123');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.state.test).toBe('data');
    });

    it('should update conversation state', () => {
      manager.startConversation('user123', 'sync-discussions', { step: 1 });

      const updated = manager.updateConversation('user123', { step: 2 });
      expect(updated).toBe(true);

      const retrieved = manager.getConversation('user123');
      expect(retrieved?.state.step).toBe(2);
    });

    it('should end a conversation', () => {
      manager.startConversation('user123', 'sync-discussions', {});

      const ended = manager.endConversation('user123');
      expect(ended).toBe(true);

      const retrieved = manager.getConversation('user123');
      expect(retrieved).toBeNull();
    });

    it('should detect active conversations', () => {
      expect(manager.hasActiveConversation('user123')).toBe(false);

      manager.startConversation('user123', 'sync-discussions', {});
      expect(manager.hasActiveConversation('user123')).toBe(true);

      manager.endConversation('user123');
      expect(manager.hasActiveConversation('user123')).toBe(false);
    });
  });

  describe('conversation isolation', () => {
    it('should keep conversations separate per user', () => {
      manager.startConversation('user1', 'sync-discussions', { data: 'user1' });
      manager.startConversation('user2', 'sync-discussions', { data: 'user2' });

      const conv1 = manager.getConversation('user1');
      const conv2 = manager.getConversation('user2');

      expect(conv1?.state.data).toBe('user1');
      expect(conv2?.state.data).toBe('user2');
    });
  });
});

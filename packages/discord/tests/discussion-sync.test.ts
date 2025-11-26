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

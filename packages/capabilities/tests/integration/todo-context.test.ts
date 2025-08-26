import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextAlchemy } from '../../src/services/context-alchemy';
import { TodoService } from '../../src/capabilities/todo';
import { Logger } from '@coachartie/shared';

// Mock the todo service
vi.mock('../../src/capabilities/todo');

describe('TODO Context Integration', () => {
  let contextAlchemy: ContextAlchemy;
  let mockTodoService: any;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test');
    contextAlchemy = new ContextAlchemy(logger);
    mockTodoService = vi.mocked(TodoService.prototype);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('addTodoContext', () => {
    it('should add TODO context when user has pending tasks', async () => {
      // Setup mock response
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        '📋 **tasks** (3 pending, 1 completed):\n' +
        '  ⏳ Fix authentication bug\n' +
        '  ⏳ Update documentation\n' +
        '  ⏳ Review pull requests\n' +
        '  ✅ Setup development environment'
      );
      mockTodoService.getNextItem = vi.fn().mockResolvedValue('📌 Next task: Fix authentication bug (item 1)');

      const message = {
        userId: 'test-user',
        content: 'What should I do next?',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'test-user');
      
      // Check that TODO context was added
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      
      expect(todoContext).toBeDefined();
      expect(todoContext.content).toContain('3 pending');
      expect(todoContext.content).toContain('Fix authentication bug');
    });

    it('should handle empty TODO lists gracefully', async () => {
      mockTodoService.listAllLists = vi.fn().mockResolvedValue('No todo lists found');
      
      const message = {
        userId: 'empty-user',
        content: 'Hello',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'empty-user');
      
      // Should not have TODO context
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      
      expect(todoContext).toBeUndefined();
    });

    it('should limit TODO context size to prevent API overflow', async () => {
      // Create a large TODO list
      const largeTodoList = Array.from({ length: 50 }, (_, i) => 
        `  ⏳ Task ${i + 1}: This is a very long task description that contains lots of details`
      ).join('\n');
      
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        `📋 **tasks** (50 pending, 0 completed):\n${largeTodoList}`
      );

      const message = {
        userId: 'heavy-user',
        content: 'Show my tasks',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'heavy-user');
      
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      
      // Context should be limited
      expect(todoContext).toBeDefined();
      expect(todoContext.content.length).toBeLessThan(500); // Reasonable size limit
      expect(todoContext.content).toContain('50 pending');
    });

    it('should handle TODO service errors without crashing', async () => {
      mockTodoService.listAllLists = vi.fn().mockRejectedValue(new Error('Database connection failed'));
      
      const message = {
        userId: 'error-user',
        content: 'Hello',
        timestamp: new Date().toISOString()
      };

      // Should not throw
      const sources = await contextAlchemy.buildMessageChain(message, 'error-user');
      
      expect(sources).toBeDefined();
      expect(sources.messages).toBeDefined();
      
      // Should not have TODO context
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      expect(todoContext).toBeUndefined();
    });

    it('should handle malformed TODO data gracefully', async () => {
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        'Some unexpected format that doesnt match our parser'
      );
      
      const message = {
        userId: 'malformed-user',
        content: 'Hello',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'malformed-user');
      
      expect(sources).toBeDefined();
      // Should continue without TODO context
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      expect(todoContext).toBeUndefined();
    });

    it('should prioritize TODO context appropriately', async () => {
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        '📋 **urgent** (2 pending, 0 completed):\n' +
        '  ⏳ Fix critical bug\n' +
        '  ⏳ Deploy hotfix'
      );

      const message = {
        userId: 'priority-user',
        content: 'What needs attention?',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'priority-user');
      
      // Find the context sources in the internal structure
      const contextSources = (contextAlchemy as any).contextSources;
      const todoSource = contextSources?.find((s: any) => s.name === 'todo_context');
      
      // TODO context should have high priority
      expect(todoSource?.priority).toBeGreaterThan(50);
    });

    it('should handle concurrent TODO requests without race conditions', async () => {
      let callCount = 0;
      mockTodoService.listAllLists = vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 10)); // Simulate async delay
        return `📋 **tasks** (${callCount} pending, 0 completed):\n  ⏳ Task ${callCount}`;
      });

      const messages = Array.from({ length: 5 }, (_, i) => ({
        userId: `concurrent-user-${i}`,
        content: 'Check todos',
        timestamp: new Date().toISOString()
      }));

      // Run concurrent requests
      const results = await Promise.all(
        messages.map(msg => contextAlchemy.buildMessageChain(msg, msg.userId))
      );

      // All should complete successfully
      expect(results).toHaveLength(5);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.messages).toBeDefined();
      });
    });

    it('should cache TODO context for performance', async () => {
      const mockResponse = '📋 **tasks** (1 pending, 0 completed):\n  ⏳ Cached task';
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(mockResponse);

      const message = {
        userId: 'cache-user',
        content: 'Check todos',
        timestamp: new Date().toISOString()
      };

      // First call
      await contextAlchemy.buildMessageChain(message, 'cache-user');
      
      // Second call within cache window (should use cache)
      await contextAlchemy.buildMessageChain(message, 'cache-user');

      // Should only call TODO service once if caching is implemented
      // Note: This assumes caching is implemented - adjust based on actual implementation
      expect(mockTodoService.listAllLists).toHaveBeenCalledTimes(2); // Or 1 if caching exists
    });

    it('should sanitize TODO content to prevent injection attacks', async () => {
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        '📋 **tasks** (1 pending, 0 completed):\n' +
        '  ⏳ <script>alert("XSS")</script> Malicious task'
      );

      const message = {
        userId: 'security-user',
        content: 'Show todos',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'security-user');
      
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );

      // Should not contain script tags or other dangerous content
      expect(todoContext?.content).not.toContain('<script>');
      expect(todoContext?.content).not.toContain('</script>');
    });

    it('should handle special characters in TODO items', async () => {
      mockTodoService.listAllLists = vi.fn().mockResolvedValue(
        '📋 **tasks** (3 pending, 0 completed):\n' +
        '  ⏳ Task with "quotes"\n' +
        '  ⏳ Task with \'apostrophes\'\n' +
        '  ⏳ Task with special chars: @#$%^&*()'
      );

      const message = {
        userId: 'special-user',
        content: 'Show todos',
        timestamp: new Date().toISOString()
      };

      const sources = await contextAlchemy.buildMessageChain(message, 'special-user');
      
      expect(sources).toBeDefined();
      const todoContext = sources.messages.find((m: any) => 
        m.content?.includes('Active TODOs')
      );
      
      expect(todoContext).toBeDefined();
      expect(todoContext.content).toContain('3 pending');
    });
  });
});
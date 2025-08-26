import { logger } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';
import { promptManager } from './prompt-manager.js';

/**
 * Memory Search Reflection - Let LLM freestyle generate search queries
 * Takes user message → generates 24 wild search queries through pure AI vibes
 * No regex, no rules, just neural network understanding
 */
export class MemorySearchReflection {
  private static instance: MemorySearchReflection;
  
  static getInstance(): MemorySearchReflection {
    if (!this.instance) {
      this.instance = new MemorySearchReflection();
    }
    return this.instance;
  }
  
  /**
   * Turn user message into 24 search queries using LLM freestyle
   * Uses cheap/free models and XML capability format
   */
  async explodeQuery(userMessage: string, userId: string): Promise<string[]> {
    try {
      logger.info(`🎆 Exploding query: "${userMessage.substring(0, 50)}..."`);
      
      // Try to get prompt from database first
      const promptTemplate = await promptManager.getPrompt('memory_search_explosion');
      
      const prompt = promptTemplate?.content || `You are a memory search assistant. The user just said: "${userMessage}"
      
Generate 24 different memory search queries to find relevant past conversations and memories.
Be creative! Think about:
- What they're REALLY asking about
- Related topics and concepts  
- Past contexts this might relate to
- Emotional undertones
- Similar situations
- Broader themes
- Specific details they might be referencing
- Time-based patterns

Output ONLY XML tags, one per line, no other text:
<capability name="memory" action="search" query="[your search query here]" />

Example for "What food do I like?":
<capability name="memory" action="search" query="favorite foods" />
<capability name="memory" action="search" query="pizza preferences" />
<capability name="memory" action="search" query="restaurant recommendations" />
<capability name="memory" action="search" query="dietary restrictions" />
<capability name="memory" action="search" query="cooking at home" />
<capability name="memory" action="search" query="breakfast habits" />
<capability name="memory" action="search" query="coffee preferences" />
<capability name="memory" action="search" query="takeout orders" />
<capability name="memory" action="search" query="food allergies" />
<capability name="memory" action="search" query="favorite cuisines" />
<capability name="memory" action="search" query="meal planning" />
<capability name="memory" action="search" query="snack preferences" />
<capability name="memory" action="search" query="dinner conversations about food" />
<capability name="memory" action="search" query="taco tuesday" />
<capability name="memory" action="search" query="weekend brunch spots" />
<capability name="memory" action="search" query="spicy food tolerance" />
<capability name="memory" action="search" query="vegetarian options discussed" />
<capability name="memory" action="search" query="food delivery apps used" />
<capability name="memory" action="search" query="grocery shopping habits" />
<capability name="memory" action="search" query="eating schedule" />
<capability name="memory" action="search" query="comfort foods mentioned" />
<capability name="memory" action="search" query="food-related memories shared" />
<capability name="memory" action="search" query="restaurant experiences" />
<capability name="memory" action="search" query="cultural food preferences" />

Now generate 24 queries for: "${userMessage}"`;

      // Use cheapest model available
      const model = 'openai/gpt-3.5-turbo'; // Cheap and good for this
      // Just use the regular generate method with the prompt
      const messages = [
        { role: 'system' as const, content: 'You are a memory search query generator.' },
        { role: 'user' as const, content: prompt }
      ];
      
      const response = await openRouterService.generateFromMessageChain(
        messages,
        userId,
        { temperature: 0.8, max_tokens: 800 }
      );
      
      // Extract queries from XML tags
      const queries = this.extractQueriesFromXML(response);
      
      logger.info(`🎯 Generated ${queries.length} search queries from LLM reflection`);
      
      // If we got less than 24, add some fallbacks
      if (queries.length < 24) {
        // Add the original message
        queries.push(userMessage);
        
        // Add individual words from the message
        const words = userMessage.split(/\s+/).filter(w => w.length > 3);
        words.forEach(word => {
          if (queries.length < 24) {
            queries.push(word.toLowerCase());
          }
        });
      }
      
      return queries.slice(0, 24); // Ensure max 24
      
    } catch (error) {
      logger.warn('Memory search reflection failed, using fallback:', error);
      
      // Fallback: just return the original message and some basic variations
      return [
        userMessage,
        userMessage.toLowerCase(),
        ...userMessage.split(/\s+/).filter(w => w.length > 2)
      ].slice(0, 24);
    }
  }
  
  /**
   * Extract search queries from XML capability tags
   */
  private extractQueriesFromXML(xmlContent: string): string[] {
    const queries: string[] = [];
    
    // Simple XML extraction (no regex!)
    const lines = xmlContent.split('\n');
    for (const line of lines) {
      if (line.includes('query="')) {
        const start = line.indexOf('query="') + 7;
        const end = line.indexOf('"', start);
        if (end > start) {
          const query = line.substring(start, end);
          if (query.length > 0) {
            queries.push(query);
          }
        }
      }
    }
    
    return queries;
  }
  
  /**
   * Rank memories by relevance using LLM
   */
  async rankMemories(
    userMessage: string, 
    memories: Array<{id: string, content: string}>,
    limit: number = 10
  ): Promise<Array<{id: string, content: string, relevance: number}>> {
    
    if (memories.length === 0) return [];
    
    try {
      // Build a simple prompt for ranking
      const memoryList = memories.slice(0, 30).map((m, i) => 
        `${i}: ${m.content.substring(0, 100)}...`
      ).join('\n');
      
      const prompt = `User asked: "${userMessage}"
      
Rate each memory's relevance (0-10):
${memoryList}

Output format - just numbers, one per line:
8
2
10
5
...`;

      const messages = [
        { role: 'system' as const, content: 'You are a memory relevance scorer.' },
        { role: 'user' as const, content: prompt }
      ];
      
      const response = await openRouterService.generateFromMessageChain(
        messages,
        'system',
        { temperature: 0.3, max_tokens: 200 }
      );
      
      // Parse scores
      const scores = response.split('\n')
        .map(line => parseFloat(line.trim()))
        .filter(n => !isNaN(n));
      
      // Combine with memories
      const ranked = memories.slice(0, scores.length).map((m, i) => ({
        ...m,
        relevance: scores[i] || 0
      }));
      
      // Sort by relevance and return top N
      return ranked
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit);
        
    } catch (error) {
      logger.warn('Memory ranking failed:', error);
      // Return as-is if ranking fails
      return memories.slice(0, limit).map(m => ({...m, relevance: 5}));
    }
  }
}

export const memorySearchReflection = MemorySearchReflection.getInstance();
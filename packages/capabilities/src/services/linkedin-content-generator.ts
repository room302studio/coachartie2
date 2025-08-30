import { logger } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';

/**
 * LinkedIn Content Generator Service
 * 
 * Generates professional LinkedIn content using AI, tailored to Coach Artie's voice and style
 */

interface ContentGenerationOptions {
  topic: string;
  tone: 'professional' | 'casual' | 'thought-leadership' | 'inspirational';
  length: 'short' | 'medium' | 'long';
  includeHashtags: boolean;
  includeCallToAction: boolean;
  targetAudience?: string;
}

interface GeneratedContent {
  content: string;
  hashtags: string[];
  estimatedEngagement: 'low' | 'medium' | 'high';
  scheduledTime?: Date;
}

class LinkedInContentGenerator {
  private coachArtiePersonality = `You are Coach Artie, an AI assistant and coach focused on helping people grow and achieve their potential. Your voice is:
- Encouraging and supportive
- Data-driven but personable  
- Growth-oriented and optimistic
- Knowledgeable about AI, technology, and personal development
- Professional but not corporate
- Genuine and authentic`;

  /**
   * Generate LinkedIn post content
   */
  async generatePost(options: ContentGenerationOptions): Promise<GeneratedContent> {
    const { topic, tone, length, includeHashtags, includeCallToAction, targetAudience } = options;
    
    try {
      const { contextAlchemy } = await import('./context-alchemy.js');
      const { promptManager } = await import('./prompt-manager.js');
      
      const userMessage = this.buildPrompt(options);
      
      logger.info(`🎯 Generating LinkedIn content for topic: "${topic}" with tone: ${tone}`);
      
      // Get base system prompt from database
      const baseSystemPrompt = await promptManager.getCapabilityInstructions(userMessage);
      
      // Build intelligent message chain via Context Alchemy
      const { messages } = await contextAlchemy.buildMessageChain(
        userMessage,
        'linkedin-content-generation',
        baseSystemPrompt
      );
      
      const response = await openRouterService.generateFromMessageChain(
        messages,
        'linkedin-content-generation'
      );
      
      // Parse the response to extract content and metadata
      const parsedContent = this.parseGeneratedContent(response, options);
      
      logger.info(`✅ Generated LinkedIn post: ${parsedContent.content.substring(0, 50)}...`);
      
      return parsedContent;
    } catch (error) {
      logger.error('❌ Failed to generate LinkedIn content:', error);
      throw error;
    }
  }

  /**
   * Generate multiple content variations for A/B testing
   */
  async generateVariations(options: ContentGenerationOptions, count: number = 3): Promise<GeneratedContent[]> {
    const variations: GeneratedContent[] = [];
    
    for (let i = 0; i < count; i++) {
      try {
        const variation = await this.generatePost({
          ...options,
          // Add variation prompts
        });
        variations.push(variation);
      } catch (error) {
        logger.error(`❌ Failed to generate variation ${i + 1}:`, error);
      }
    }
    
    return variations;
  }

  /**
   * Generate content based on trending topics
   */
  async generateTrendingContent(): Promise<GeneratedContent[]> {
    const trendingTopics = [
      'AI and automation trends',
      'Remote work productivity',
      'Professional development',
      'Technology innovation',
      'Leadership insights',
      'Personal growth strategies'
    ];
    
    const contents: GeneratedContent[] = [];
    
    for (const topic of trendingTopics) {
      try {
        const content = await this.generatePost({
          topic,
          tone: 'thought-leadership',
          length: 'medium',
          includeHashtags: true,
          includeCallToAction: true
        });
        contents.push(content);
      } catch (error) {
        logger.error(`❌ Failed to generate content for topic "${topic}":`, error);
      }
    }
    
    return contents;
  }

  /**
   * Generate content from Coach Artie's recent activities or insights
   */
  async generateFromActivity(): Promise<GeneratedContent> {
    // This would integrate with Coach Artie's memory system to generate content
    // based on recent conversations, insights, or learnings
    
    const prompt = `${this.coachArtiePersonality}

Generate a LinkedIn post about a recent insight or learning experience you've had as an AI assistant. Make it personal, authentic, and valuable to your professional network. Share something that would genuinely help others grow or think differently.

Requirements:
- Professional but personal tone
- 200-300 characters
- Include a question to drive engagement
- Share a specific insight or observation
- End with 2-3 relevant hashtags`;

    try {
      const { contextAlchemy } = await import('./context-alchemy.js');
      const { promptManager } = await import('./prompt-manager.js');
      
      // Get base system prompt from database
      const baseSystemPrompt = await promptManager.getCapabilityInstructions(prompt);
      
      // Build intelligent message chain via Context Alchemy
      const { messages } = await contextAlchemy.buildMessageChain(
        prompt,
        'linkedin-activity-content',
        baseSystemPrompt
      );
      
      const response = await openRouterService.generateFromMessageChain(messages, 'linkedin-activity-content');
      
      return this.parseGeneratedContent(response, {
        topic: 'personal insight',
        tone: 'professional',
        length: 'medium',
        includeHashtags: true,
        includeCallToAction: true
      });
    } catch (error) {
      logger.error('❌ Failed to generate activity-based content:', error);
      throw error;
    }
  }

  /**
   * Build the AI prompt for content generation
   */
  private buildPrompt(options: ContentGenerationOptions): string {
    const { topic, tone, length, includeHashtags, includeCallToAction, targetAudience } = options;
    
    const lengthGuidance = {
      short: '150-200 characters',
      medium: '200-300 characters', 
      long: '300-400 characters'
    };

    const toneGuidance = {
      professional: 'Professional, informative, and credible',
      casual: 'Conversational, approachable, and friendly',
      'thought-leadership': 'Insightful, thought-provoking, and authoritative',
      inspirational: 'Motivating, uplifting, and empowering'
    };

    return `${this.coachArtiePersonality}

Create a LinkedIn post about "${topic}" with the following requirements:

Tone: ${toneGuidance[tone]}
Length: ${lengthGuidance[length]}
${targetAudience ? `Target audience: ${targetAudience}` : ''}
${includeHashtags ? 'Include 2-4 relevant hashtags at the end' : 'No hashtags'}
${includeCallToAction ? 'Include a call to action or engagement question' : 'No call to action needed'}

Guidelines:
- Write in Coach Artie's authentic voice
- Make it valuable and engaging
- Use line breaks for readability on LinkedIn
- Be specific and actionable
- Avoid corporate jargon
- Make it genuinely helpful to your network

Return only the post content, ready to publish on LinkedIn.`;
  }

  /**
   * Parse the generated content and extract metadata
   */
  private parseGeneratedContent(content: string, options: ContentGenerationOptions): GeneratedContent {
    // Extract hashtags if present
    const hashtagRegex = /#[\w]+/g;
    const hashtags = content.match(hashtagRegex) || [];
    
    // Remove hashtags from main content for separate handling
    const cleanContent = content.replace(hashtagRegex, '').trim();
    
    // Estimate engagement potential based on content characteristics
    const estimatedEngagement = this.estimateEngagement(cleanContent, options);
    
    return {
      content: cleanContent,
      hashtags: hashtags.map(tag => tag.replace('#', '')),
      estimatedEngagement
    };
  }

  /**
   * Estimate engagement potential based on content analysis
   */
  private estimateEngagement(content: string, options: ContentGenerationOptions): 'low' | 'medium' | 'high' {
    let score = 0;
    
    // Length score
    if (content.length >= 200 && content.length <= 300) {score += 2;}
    else if (content.length > 300) {score += 1;}
    
    // Question mark indicates engagement-driving question
    if (content.includes('?')) {score += 2;}
    
    // Tone impact
    if (options.tone === 'thought-leadership' || options.tone === 'inspirational') {score += 2;}
    
    // Call to action
    if (options.includeCallToAction) {score += 1;}
    
    // Hashtags help discoverability
    if (options.includeHashtags) {score += 1;}
    
    if (score >= 6) {return 'high';}
    if (score >= 4) {return 'medium';}
    return 'low';
  }

  /**
   * Suggest optimal posting times based on audience and content type
   */
  suggestPostingTime(content: GeneratedContent): Date[] {
    const now = new Date();
    const suggestions: Date[] = [];
    
    // Tuesday-Thursday, 8-10 AM or 12-2 PM are typically high engagement times
    const optimalDays = [2, 3, 4]; // Tuesday, Wednesday, Thursday
    const optimalHours = [8, 9, 12, 13]; // 8-9 AM, 12-1 PM
    
    for (const day of optimalDays) {
      for (const hour of optimalHours) {
        const suggestionDate = new Date(now);
        suggestionDate.setDate(now.getDate() + ((day - now.getDay() + 7) % 7));
        suggestionDate.setHours(hour, 0, 0, 0);
        
        // Only suggest future times
        if (suggestionDate > now) {
          suggestions.push(suggestionDate);
        }
      }
    }
    
    return suggestions.slice(0, 5); // Return top 5 suggestions
  }
}

// Export singleton instance
export const linkedInContentGenerator = new LinkedInContentGenerator();
export { LinkedInContentGenerator, ContentGenerationOptions, GeneratedContent };
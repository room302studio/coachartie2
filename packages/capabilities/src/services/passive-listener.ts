import { logger } from '@coachartie/shared';
import { getDatabase } from '@coachartie/shared';
import { IncomingMessage } from '@coachartie/shared';

interface ExtractedEntity {
  text: string;
  type: 'person' | 'date' | 'time' | 'event' | 'location' | 'task' | 'deadline';
  confidence: number;
}

interface ExtractedInformation {
  content: string;
  entities: ExtractedEntity[];
  importance: number; // 1-10 scale
  categories: string[]; // 'meeting', 'task', 'personal', etc.
  sentiment: 'positive' | 'negative' | 'neutral';
  source: {
    messageId: string;
    userId: string;
    channel: string;
    timestamp: Date;
  };
}

interface PassiveMemory {
  id: string;
  content: string;
  original_message: string;
  speaker: string;
  channel: string;
  entities: string; // JSON serialized ExtractedEntity[]
  importance: number;
  categories: string; // JSON serialized string[]
  sentiment: string;
  is_confirmed: boolean;
  created_at: string;
  expires_at?: string;
}

interface PrivacySettings {
  enablePassiveListening: boolean;
  dataRetentionDays: number;
  excludedChannels: string[];
  excludedUsers: string[];
  anonymizePersonalInfo: boolean;
}

/**
 * Passive Memory Listening System
 * 
 * Captures and stores memories from ambient conversations to build
 * contextual awareness without requiring direct interaction.
 * 
 * Phase 1: Basic message capture with simple entity extraction
 */
export class PassiveListener {
  private static instance: PassiveListener;
  private dbReady = false;
  private relevanceThreshold = 6; // Only store information scoring 6+ out of 10

  static getInstance(): PassiveListener {
    if (!PassiveListener.instance) {
      PassiveListener.instance = new PassiveListener();
    }
    return PassiveListener.instance;
  }

  async initializeDatabase(): Promise<void> {
    if (this.dbReady) {return;}

    try {
      const db = await getDatabase();
      
      // Create passive memories table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS passive_memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          original_message TEXT NOT NULL,
          speaker TEXT NOT NULL,
          channel TEXT NOT NULL,
          entities TEXT DEFAULT '[]',
          importance INTEGER DEFAULT 5,
          categories TEXT DEFAULT '[]',
          sentiment TEXT DEFAULT 'neutral',
          is_confirmed BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME
        )
      `);

      // Create privacy consent table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS passive_listening_consent (
          user_id TEXT PRIMARY KEY,
          consent_given BOOLEAN DEFAULT 0,
          consent_date DATETIME,
          data_retention_days INTEGER DEFAULT 30,
          anonymize_personal BOOLEAN DEFAULT 1,
          enable_passive_listening BOOLEAN DEFAULT 0
        )
      `);

      // Create indexes for efficient querying
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_passive_memories_speaker ON passive_memories(speaker);
        CREATE INDEX IF NOT EXISTS idx_passive_memories_channel ON passive_memories(channel);
        CREATE INDEX IF NOT EXISTS idx_passive_memories_importance ON passive_memories(importance);
        CREATE INDEX IF NOT EXISTS idx_passive_memories_created_at ON passive_memories(created_at);
        CREATE INDEX IF NOT EXISTS idx_passive_memories_expires_at ON passive_memories(expires_at);
      `);

      this.dbReady = true;
      logger.info('✅ Passive listener database initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize passive listener database:', error);
      throw error;
    }
  }

  /**
   * Main entry point for processing ambient messages
   */
  async processAmbientMessage(message: IncomingMessage): Promise<void> {
    try {
      await this.initializeDatabase();

      // Check if we should process this message
      if (!(await this.shouldProcessMessage(message))) {
        return;
      }

      // Extract information from the message
      const extractedInfo = await this.extractInformation(message);

      // Only store if it meets our relevance threshold
      if (extractedInfo.importance >= this.relevanceThreshold) {
        await this.storePassiveMemory(extractedInfo);
        logger.info(`👂 Passive memory stored: "${extractedInfo.content}" (importance: ${extractedInfo.importance})`);
      } else {
        logger.debug(`👂 Message below relevance threshold: ${extractedInfo.importance}/${this.relevanceThreshold}`);
      }
    } catch (error) {
      logger.error('❌ Failed to process ambient message:', error);
    }
  }

  /**
   * Check if we should process this message based on privacy settings
   */
  private async shouldProcessMessage(message: IncomingMessage): Promise<boolean> {
    try {
      const db = await getDatabase();
      
      // Get user's privacy settings
      const consent = await db.get(`
        SELECT * FROM passive_listening_consent WHERE user_id = ?
      `, [message.userId]);

      // Default to no processing if no explicit consent
      if (!consent || !consent.enable_passive_listening) {
        return false;
      }

      // Don't process direct messages to the bot (those are handled by main orchestrator)
      if (message.message.toLowerCase().includes('@coachartie') || 
          message.message.toLowerCase().includes('coach artie')) {
        return false;
      }

      // Check if message is too short to be meaningful
      if (message.message.length < 10) {
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Failed to check message processing permissions:', error);
      return false;
    }
  }

  /**
   * Extract meaningful information from a message
   */
  private async extractInformation(message: IncomingMessage): Promise<ExtractedInformation> {
    const text = message.message;
    
    // Simple entity extraction (Phase 1 - basic implementation)
    const entities = this.extractSimpleEntities(text);
    
    // Calculate importance based on content patterns
    const importance = this.calculateImportance(text, entities);
    
    // Categorize the content
    const categories = this.categorizeContent(text, entities);
    
    // Simple sentiment analysis
    const sentiment = this.analyzeSentiment(text);
    
    // Extract the core content
    const content = this.extractCoreContent(text, entities);

    return {
      content,
      entities,
      importance,
      categories,
      sentiment,
      source: {
        messageId: message.id,
        userId: message.userId,
        channel: message.source,
        timestamp: new Date()
      }
    };
  }

  /**
   * Simple entity extraction using pattern matching
   */
  private extractSimpleEntities(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const lowerText = text.toLowerCase();

    // Time patterns
    const timePatterns = [
      /(\d{1,2}:\d{2}\s*(am|pm|AM|PM))/g,
      /(\d{1,2}\s*(am|pm|AM|PM))/g,
      /(at\s+\d{1,2})/g
    ];

    timePatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          entities.push({
            text: match.trim(),
            type: 'time',
            confidence: 0.8
          });
        });
      }
    });

    // Date patterns
    const datePatterns = [
      /(today|tomorrow|yesterday)/gi,
      /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi,
      /(next\s+week|this\s+week|last\s+week)/gi,
      /(\d{1,2}\/\d{1,2}\/\d{2,4})/g
    ];

    datePatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          entities.push({
            text: match.trim(),
            type: 'date',
            confidence: 0.8
          });
        });
      }
    });

    // Event/meeting patterns
    const eventPatterns = [
      /(meeting|call|conference|demo|presentation|standup|sprint|review)/gi,
      /(deadline|due\s+date|milestone)/gi
    ];

    eventPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          entities.push({
            text: match.trim(),
            type: 'event',
            confidence: 0.7
          });
        });
      }
    });

    return entities;
  }

  /**
   * Calculate importance score based on content analysis
   */
  private calculateImportance(text: string, entities: ExtractedEntity[]): number {
    let score = 5; // Base score

    const lowerText = text.toLowerCase();

    // High importance indicators
    if (lowerText.includes('deadline') || lowerText.includes('urgent')) {score += 3;}
    if (lowerText.includes('meeting') || lowerText.includes('call')) {score += 2;}
    if (lowerText.includes('canceled') || lowerText.includes('postponed')) {score += 2;}
    if (lowerText.includes('important') || lowerText.includes('critical')) {score += 2;}
    
    // Time-based urgency
    if (lowerText.includes('today') || lowerText.includes('now')) {score += 2;}
    if (lowerText.includes('tomorrow')) {score += 1;}
    
    // Entity count bonus
    score += Math.min(entities.length, 3); // Up to 3 bonus points for entities

    // Question indicators (less important for passive capture)
    if (text.includes('?')) {score -= 1;}

    return Math.max(1, Math.min(10, score));
  }

  /**
   * Categorize content based on patterns
   */
  private categorizeContent(text: string, entities: ExtractedEntity[]): string[] {
    const categories: string[] = [];
    const lowerText = text.toLowerCase();

    if (lowerText.includes('meeting') || lowerText.includes('call') || lowerText.includes('standup')) {
      categories.push('meeting');
    }
    
    if (lowerText.includes('deadline') || lowerText.includes('due') || lowerText.includes('milestone')) {
      categories.push('deadline');
    }
    
    if (lowerText.includes('project') || lowerText.includes('task') || lowerText.includes('work')) {
      categories.push('work');
    }
    
    if (lowerText.includes('canceled') || lowerText.includes('postponed') || lowerText.includes('moved')) {
      categories.push('schedule_change');
    }

    // Add default category if none found
    if (categories.length === 0) {
      categories.push('general');
    }

    return categories;
  }

  /**
   * Simple sentiment analysis
   */
  private analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' {
    const lowerText = text.toLowerCase();
    
    const positiveWords = ['great', 'good', 'awesome', 'excellent', 'perfect', 'love', 'amazing'];
    const negativeWords = ['problem', 'issue', 'concern', 'worried', 'difficult', 'hate', 'terrible'];
    
    const positiveCount = positiveWords.filter(word => lowerText.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lowerText.includes(word)).length;
    
    if (positiveCount > negativeCount) {return 'positive';}
    if (negativeCount > positiveCount) {return 'negative';}
    return 'neutral';
  }

  /**
   * Extract core content, removing noise
   */
  private extractCoreContent(text: string, entities: ExtractedEntity[]): string {
    // For Phase 1, just clean up the text slightly
    let content = text.trim();
    
    // Remove common noise words at the start
    content = content.replace(/^(well,|so,|anyway,|btw,|oh,)\s*/i, '');
    
    // Truncate if too long
    if (content.length > 200) {
      content = content.substring(0, 200) + '...';
    }
    
    return content;
  }

  /**
   * Store passive memory in database
   */
  private async storePassiveMemory(info: ExtractedInformation): Promise<void> {
    try {
      const db = await getDatabase();
      
      const id = `passive_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30-day default retention

      await db.run(`
        INSERT INTO passive_memories 
        (id, content, original_message, speaker, channel, entities, importance, categories, sentiment, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        info.content,
        info.source.messageId,
        info.source.userId,
        info.source.channel,
        JSON.stringify(info.entities),
        info.importance,
        JSON.stringify(info.categories),
        info.sentiment,
        expiresAt.toISOString()
      ]);

      logger.debug(`Stored passive memory: ${id}`);
    } catch (error) {
      logger.error('Failed to store passive memory:', error);
      throw error;
    }
  }

  /**
   * Set user consent for passive listening
   */
  async setUserConsent(userId: string, settings: Partial<PrivacySettings>): Promise<void> {
    try {
      await this.initializeDatabase();
      const db = await getDatabase();

      await db.run(`
        INSERT OR REPLACE INTO passive_listening_consent 
        (user_id, consent_given, consent_date, data_retention_days, anonymize_personal, enable_passive_listening)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        userId,
        settings.enablePassiveListening ? 1 : 0,
        new Date().toISOString(),
        settings.dataRetentionDays || 30,
        settings.anonymizePersonalInfo ? 1 : 0,
        settings.enablePassiveListening ? 1 : 0
      ]);

      logger.info(`Updated passive listening consent for user ${userId}: ${settings.enablePassiveListening ? 'enabled' : 'disabled'}`);
    } catch (error) {
      logger.error('Failed to set user consent:', error);
      throw error;
    }
  }

  /**
   * Get stored passive memories for a user/channel
   */
  async getPassiveMemories(userId: string, limit: number = 10): Promise<PassiveMemory[]> {
    try {
      await this.initializeDatabase();
      const db = await getDatabase();

      const memories = await db.all(`
        SELECT * FROM passive_memories 
        WHERE speaker = ?
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `, [userId, limit]);

      return memories;
    } catch (error) {
      logger.error('Failed to get passive memories:', error);
      return [];
    }
  }

  /**
   * Clean up expired passive memories
   */
  async cleanupExpiredMemories(): Promise<void> {
    try {
      await this.initializeDatabase();
      const db = await getDatabase();

      const result = await db.run(`
        DELETE FROM passive_memories 
        WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
      `);

      if (result.changes && result.changes > 0) {
        logger.info(`🧹 Cleaned up ${result.changes} expired passive memories`);
      }
    } catch (error) {
      logger.error('Failed to cleanup expired memories:', error);
    }
  }
}

// Export singleton
export const passiveListener = PassiveListener.getInstance();
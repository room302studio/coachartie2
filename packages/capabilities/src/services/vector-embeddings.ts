import { logger, getDatabase } from '@coachartie/shared';
import OpenAI from 'openai';

/**
 * Vector Embeddings Service - OpenAI + Local SQLite Implementation
 *
 * Uses OpenAI's text-embedding-3-small model to generate 1536-dimensional vectors
 * and stores them locally in SQLite with cosine similarity search.
 */

export interface EmbeddingVector {
  memory_id: number;
  vector: number[];
  model: string;
  dimensions: number;
  created_at: Date;
}

export interface SimilarityResult {
  memory_id: number;
  similarity_score: number;
  content: string;
}

export class VectorEmbeddingService {
  private static instance: VectorEmbeddingService;
  private initialized = false;
  private openai: OpenAI | null = null;
  private db: any = null;

  static getInstance(): VectorEmbeddingService {
    if (!VectorEmbeddingService.instance) {
      VectorEmbeddingService.instance = new VectorEmbeddingService();
    }
    return VectorEmbeddingService.instance;
  }

  /**
   * Initialize the vector embedding service with real OpenAI client
   */
  async initialize(): Promise<void> {
    if (this.initialized) {return;}

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('🚧 OPENAI_API_KEY not found - vector embeddings disabled');
      return;
    }

    this.openai = new OpenAI({ apiKey });
    this.db = await getDatabase();
    logger.info('🧠 Vector Embedding Service: OpenAI + Local SQLite initialized');
    this.initialized = true;
  }

  /**
   * Generate real OpenAI embedding vector (1536 dimensions for text-embedding-3-small)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openai) {
      throw new Error('Vector embedding service not initialized - missing OPENAI_API_KEY');
    }

    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
      });

      const embedding = response.data[0].embedding;
      logger.debug(`🧠 Generated OpenAI embedding: ${embedding.length} dimensions`);
      
      return embedding;
    } catch (error) {
      logger.error('❌ OpenAI embedding generation failed:', error);
      throw new Error(`Embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have same dimensions');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Find semantically similar memories using local vector search
   */
  async findSimilarMemories(queryText: string, limit: number = 10, threshold: number = 0.7): Promise<SimilarityResult[]> {
    if (!this.openai || !this.db) {
      logger.warn('🚧 Vector search unavailable - service not initialized');
      return [];
    }

    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbedding(queryText);

      // Get all memories with embeddings from SQLite
      const memories = await this.db.all(`
        SELECT id AS memory_id, content, embedding
        FROM memories
        WHERE embedding IS NOT NULL
      `);

      // Calculate similarities
      const results: SimilarityResult[] = [];

      for (const memory of memories) {
        try {
          const memoryEmbedding = JSON.parse(memory.embedding);
          const similarity = this.cosineSimilarity(queryEmbedding, memoryEmbedding);

          if (similarity >= threshold) {
            results.push({
              memory_id: memory.memory_id,
              similarity_score: similarity,
              content: memory.content
            });
          }
        } catch (e) {
          // Skip memories with invalid embeddings
          continue;
        }
      }

      // Sort by similarity and limit results
      results.sort((a, b) => b.similarity_score - a.similarity_score);
      const topResults = results.slice(0, limit);

      logger.info(`🔍 Found ${topResults.length} similar memories (threshold: ${threshold})`);
      return topResults;

    } catch (error) {
      logger.error('❌ Vector similarity search failed:', error);
      return [];
    }
  }

  /**
   * Store embedding in local SQLite database
   */
  async storeEmbedding(memoryId: number, text: string): Promise<boolean> {
    if (!this.openai || !this.db) {
      logger.warn('🚧 Cannot store embedding - service not initialized');
      return false;
    }

    try {
      const embedding = await this.generateEmbedding(text);

      // Store in SQLite memories table
      const result = await this.db.run(`
        UPDATE memories
        SET embedding = ?
        WHERE id = ?
      `, JSON.stringify(embedding), memoryId);

      if (result.changes > 0) {
        logger.info(`✅ Stored embedding for memory #${memoryId}`);
        return true;
      } else {
        logger.warn(`⚠️ Memory #${memoryId} not found`);
        return false;
      }

    } catch (error) {
      logger.error('❌ Failed to store embedding:', error);
      return false;
    }
  }

  /**
   * Find similar memories based on an existing memory's embedding
   */
  async findSimilarToMemory(memoryId: number, limit: number = 10, threshold: number = 0.7): Promise<SimilarityResult[]> {
    if (!this.db) {
      logger.warn('🚧 Vector search unavailable - database not initialized');
      return [];
    }

    try {
      // Get the memory and its embedding
      const memory = await this.db.get(`
        SELECT content, embedding
        FROM memories
        WHERE id = ?
      `, memoryId);

      if (!memory || !memory.embedding) {
        logger.warn(`⚠️ Memory #${memoryId} not found or has no embedding`);
        return [];
      }

      const baseEmbedding = JSON.parse(memory.embedding);

      // Get all other memories with embeddings
      const otherMemories = await this.db.all(`
        SELECT id AS memory_id, content, embedding
        FROM memories
        WHERE embedding IS NOT NULL AND id != ?
      `, memoryId);

      // Calculate similarities
      const results: SimilarityResult[] = [];

      for (const otherMemory of otherMemories) {
        try {
          const otherEmbedding = JSON.parse(otherMemory.embedding);
          const similarity = this.cosineSimilarity(baseEmbedding, otherEmbedding);

          if (similarity >= threshold) {
            results.push({
              memory_id: otherMemory.memory_id,
              similarity_score: similarity,
              content: otherMemory.content
            });
          }
        } catch (e) {
          // Skip memories with invalid embeddings
          continue;
        }
      }

      // Sort by similarity and limit results
      results.sort((a, b) => b.similarity_score - a.similarity_score);
      const topResults = results.slice(0, limit);

      logger.info(`🔍 Found ${topResults.length} memories similar to #${memoryId}`);
      return topResults;

    } catch (error) {
      logger.error('❌ Failed to find similar memories:', error);
      return [];
    }
  }

  /**
   * Check if service is ready for real embeddings
   */
  isReady(): boolean {
    return this.initialized && this.openai !== null;
  }

  /**
   * Get embedding service status
   */
  getStatus(): string {
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    const isInitialized = this.initialized;
    
    return `🧠 Vector Embedding Service (Real OpenAI Implementation)
📊 Status: ${isInitialized ? 'Initialized' : 'Not initialized'}
🔑 OpenAI API Key: ${hasApiKey ? 'Available' : 'Missing'}
🔧 Model: text-embedding-3-small (1536 dimensions)
🗄️ Storage: Supabase + pgvector (requires connection)
⚡ Features: Real semantic similarity, vector search
🚧 Next: Connect Supabase database for vector storage`;
  }
}

// Export singleton instance
export const vectorEmbeddingService = VectorEmbeddingService.getInstance();
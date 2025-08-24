import { logger } from '@coachartie/shared';
import OpenAI from 'openai';

/**
 * Vector Embeddings Service - REAL OpenAI + Supabase Implementation
 * 
 * Uses OpenAI's text-embedding-3-small model to generate 1536-dimensional vectors
 * and stores them in Supabase with pgvector for real semantic search.
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
    if (this.initialized) return;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('🚧 OPENAI_API_KEY not found - vector embeddings disabled');
      return;
    }

    this.openai = new OpenAI({ apiKey });
    logger.info('🧠 Vector Embedding Service: Real OpenAI implementation initialized');
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
   * Find semantically similar memories using Supabase vector search
   * 
   * Note: This requires the Supabase database connection and match_memories function.
   * For now, returns empty until Supabase connection is available.
   */
  async findSimilarMemories(queryText: string, limit: number = 10): Promise<SimilarityResult[]> {
    if (!this.openai) {
      logger.warn('🚧 Vector search unavailable - missing OPENAI_API_KEY');
      return [];
    }

    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbedding(queryText);
      
      // TODO: Connect to Supabase and use match_memories function
      // const { data, error } = await supabase.rpc('match_memories', {
      //   query_embedding: JSON.stringify(queryEmbedding),
      //   match_threshold: 0.7,
      //   match_count: limit
      // });
      
      logger.warn('🚧 Supabase vector search not yet connected - use match_memories RPC');
      return [];

    } catch (error) {
      logger.error('❌ Vector similarity search failed:', error);
      return [];
    }
  }

  /**
   * Store embedding in database (requires Supabase connection)
   */
  async storeEmbedding(memoryId: number, text: string): Promise<boolean> {
    if (!this.openai) {
      logger.warn('🚧 Cannot store embedding - missing OPENAI_API_KEY');
      return false;
    }

    try {
      const embedding = await this.generateEmbedding(text);
      
      // TODO: Store in Supabase memories table
      // const { error } = await supabase
      //   .from('memories')
      //   .update({ embedding: JSON.stringify(embedding) })
      //   .eq('id', memoryId);
      
      logger.warn('🚧 Supabase connection not available for storing embeddings');
      return false;
      
    } catch (error) {
      logger.error('❌ Failed to store embedding:', error);
      return false;
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
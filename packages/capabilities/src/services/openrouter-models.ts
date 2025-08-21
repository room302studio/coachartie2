import { logger } from '@coachartie/shared';

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider?: {
    context_length: number;
    max_completion_tokens?: number;
    is_moderated: boolean;
  };
  per_request_limits?: {
    prompt_tokens: string;
    completion_tokens: string;
  };
}

export class OpenRouterModelsService {
  private modelsCache: Map<string, OpenRouterModelInfo> = new Map();
  private lastFetch: number = 0;
  private cacheTTL: number = 300000; // 5 minutes

  constructor() {}

  /**
   * Fetch live model information from OpenRouter API
   */
  async fetchLiveModelInfo(): Promise<Map<string, OpenRouterModelInfo>> {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (this.modelsCache.size > 0 && (now - this.lastFetch) < this.cacheTTL) {
      logger.debug('Returning cached OpenRouter models data');
      return this.modelsCache;
    }

    try {
      logger.info('Fetching live model data from OpenRouter API');
      
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://coach-artie.local',
          'X-Title': 'Coach Artie'
        }
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format from OpenRouter API');
      }

      // Cache the models
      this.modelsCache.clear();
      data.data.forEach((model: OpenRouterModelInfo) => {
        this.modelsCache.set(model.id, model);
      });

      this.lastFetch = now;
      
      logger.info(`✅ Fetched ${this.modelsCache.size} models from OpenRouter API`);
      return this.modelsCache;

    } catch (error) {
      logger.error('Failed to fetch OpenRouter models:', error);
      
      // Return cached data if available, even if stale
      if (this.modelsCache.size > 0) {
        logger.warn('Using stale cached OpenRouter data due to API failure');
        return this.modelsCache;
      }
      
      // Return empty map if no cache available
      return new Map();
    }
  }

  /**
   * Get model information for specific models
   */
  async getModelInfo(modelIds: string[]): Promise<Record<string, OpenRouterModelInfo | null>> {
    const allModels = await this.fetchLiveModelInfo();
    const result: Record<string, OpenRouterModelInfo | null> = {};

    modelIds.forEach(modelId => {
      result[modelId] = allModels.get(modelId) || null;
    });

    return result;
  }

  /**
   * Get enhanced model data with our local context
   */
  async getEnhancedModelData(activeModels: string[], currentModel: string): Promise<any[]> {
    const modelInfoMap = await this.getModelInfo(activeModels);
    
    return activeModels.map(modelId => {
      const openrouterInfo = modelInfoMap[modelId];
      
      // Extract provider and model name
      const [provider, modelName] = modelId.split('/');
      const isFree = modelId.includes(':free');
      
      // Calculate cost per 1K tokens (convert from per-token to per-1K)
      let inputCostPer1K = 'N/A';
      let outputCostPer1K = 'N/A';
      
      if (openrouterInfo?.pricing) {
        const inputCost = parseFloat(openrouterInfo.pricing.prompt);
        const outputCost = parseFloat(openrouterInfo.pricing.completion);
        
        if (!isNaN(inputCost)) {
          inputCostPer1K = `$${(inputCost * 1000).toFixed(4)}`;
        }
        if (!isNaN(outputCost)) {
          outputCostPer1K = `$${(outputCost * 1000).toFixed(4)}`;
        }
      }

      return {
        id: modelId,
        name: modelName,
        provider,
        displayName: openrouterInfo?.name || modelName,
        description: openrouterInfo?.description || 'No description available',
        
        // Pricing info
        isFree,
        inputCostPer1K,
        outputCostPer1K,
        
        // Technical specs
        contextLength: openrouterInfo?.context_length || openrouterInfo?.top_provider?.context_length || 'Unknown',
        maxCompletionTokens: openrouterInfo?.top_provider?.max_completion_tokens || 'Unknown',
        modality: openrouterInfo?.architecture?.modality || 'text',
        isModerated: openrouterInfo?.top_provider?.is_moderated || false,
        
        // Status
        isActive: modelId === currentModel,
        isAvailable: true, // All models in our list should be available
        
        // Rate limits
        promptTokenLimit: openrouterInfo?.per_request_limits?.prompt_tokens || 'Unknown',
        completionTokenLimit: openrouterInfo?.per_request_limits?.completion_tokens || 'Unknown',
      };
    });
  }

  /**
   * Get a summary of model capabilities
   */
  async getModelSummary(activeModels: string[]): Promise<{
    totalModels: number;
    freeModels: number;
    paidModels: number;
    providers: string[];
    totalContextLength: number;
    averageInputCost: number;
  }> {
    const enhancedData = await this.getEnhancedModelData(activeModels, '');
    
    const freeModels = enhancedData.filter(m => m.isFree).length;
    const paidModels = enhancedData.length - freeModels;
    
    const providers = [...new Set(enhancedData.map(m => m.provider))];
    
    const totalContextLength = enhancedData.reduce((sum, m) => {
      const context = typeof m.contextLength === 'number' ? m.contextLength : 0;
      return sum + context;
    }, 0);
    
    // Calculate average input cost for paid models
    const paidModelsWithCost = enhancedData.filter(m => 
      !m.isFree && m.inputCostPer1K !== 'N/A'
    );
    
    const averageInputCost = paidModelsWithCost.length > 0
      ? paidModelsWithCost.reduce((sum, m) => {
          const cost = parseFloat(m.inputCostPer1K.replace('$', ''));
          return sum + (isNaN(cost) ? 0 : cost);
        }, 0) / paidModelsWithCost.length
      : 0;

    return {
      totalModels: enhancedData.length,
      freeModels,
      paidModels,
      providers,
      totalContextLength,
      averageInputCost
    };
  }
}

// Export singleton
export const openRouterModelsService = new OpenRouterModelsService();
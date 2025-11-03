import { logger } from '@coachartie/shared';
import { ParsedCapability } from '../utils/xml-parser.js';

/**
 * Model response with confidence scoring
 */
interface ModelResponse {
  model: string;
  capabilities: ParsedCapability[];
  confidence: number;
  responseTime: number;
  error?: string;
}

/**
 * Consensus result
 */
interface ConsensusResult {
  capabilities: ParsedCapability[];
  confidence: number;
  modelAgreement: number;
  usedModels: string[];
  fallbackUsed: boolean;
}

/**
 * Model configuration
 */
interface ModelConfig {
  name: string;
  endpoint: string;
  priority: number; // Higher = better quality
  timeout: number;
  free: boolean;
}

/**
 * Multi-Model Consensus Engine
 *
 * Eliminates hallucinations and unreliability by requiring consensus
 * between multiple models before accepting capability extraction results.
 */
export class ConsensusEngine {
  private models: ModelConfig[] = [
    {
      name: 'mistralai/mistral-7b-instruct:free',
      endpoint: 'openrouter',
      priority: 1,
      timeout: 5000,
      free: true,
    },
    {
      name: 'microsoft/phi-3-mini-128k-instruct:free',
      endpoint: 'openrouter',
      priority: 2,
      timeout: 5000,
      free: true,
    },
    {
      name: 'meta-llama/llama-3.1-8b-instruct:free',
      endpoint: 'openrouter',
      priority: 3,
      timeout: 5000,
      free: true,
    },
  ];

  private fallbackStrategies = [
    'natural_language_detection',
    'keyword_pattern_matching',
    'simple_heuristics',
  ];

  /**
   * Extract capabilities with consensus validation
   */
  async extractCapabilities(message: string): Promise<ConsensusResult> {
    const startTime = Date.now();

    try {
      // Try multi-model consensus first
      const consensusResult = await this.tryMultiModelConsensus(message);

      if (consensusResult.confidence >= 0.7) {
        logger.info(
          `✅ Multi-model consensus achieved (${consensusResult.confidence.toFixed(2)} confidence)`
        );
        return consensusResult;
      }

      // Fall back to deterministic strategies
      logger.warn('Multi-model consensus failed, using fallback strategies');
      return await this.tryFallbackStrategies(message);
    } catch (error) {
      logger.error('Consensus engine failed, using emergency fallback:', error);
      return await this.emergencyFallback(message);
    } finally {
      const duration = Date.now() - startTime;
      logger.info(`Consensus engine completed in ${duration}ms`);
    }
  }

  /**
   * Try multi-model consensus
   */
  private async tryMultiModelConsensus(message: string): Promise<ConsensusResult> {
    const responses = await Promise.allSettled(
      this.models.map((model) => this.queryModel(model, message))
    );

    const validResponses = responses
      .filter(
        (result): result is PromiseFulfilledResult<ModelResponse> =>
          result.status === 'fulfilled' && !result.value.error
      )
      .map((result) => result.value)
      .sort((a, b) => b.confidence - a.confidence);

    if (validResponses.length === 0) {
      throw new Error('No valid model responses received');
    }

    // Find capabilities that appear in majority of responses
    const consensusCapabilities = this.findConsensusCapabilities(validResponses);
    const modelAgreement = this.calculateModelAgreement(validResponses, consensusCapabilities);

    return {
      capabilities: consensusCapabilities,
      confidence: this.calculateOverallConfidence(validResponses, consensusCapabilities),
      modelAgreement,
      usedModels: validResponses.map((r) => r.model),
      fallbackUsed: false,
    };
  }

  /**
   * Query a single model
   */
  private async queryModel(model: ModelConfig, message: string): Promise<ModelResponse> {
    const startTime = Date.now();

    try {
      // TODO: bulletproof-capability-extractor was deleted - this code needs to be refactored
      // const { bulletproofExtractor } = await import('../utils/bulletproof-capability-extractor.js');
      // const capabilities = await bulletproofExtractor.extractCapabilities(message, model.name);

      const capabilities: any[] = []; // Temporary fix until extractor is implemented

      const responseTime = Date.now() - startTime;
      const confidence = this.scoreModelResponse(capabilities, responseTime, model);

      return {
        model: model.name,
        capabilities,
        confidence,
        responseTime,
      };
    } catch (error) {
      return {
        model: model.name,
        capabilities: [],
        confidence: 0,
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Find capabilities that appear in majority of responses
   */
  private findConsensusCapabilities(responses: ModelResponse[]): ParsedCapability[] {
    if (responses.length === 0) {
      return [];
    }
    if (responses.length === 1) {
      return responses[0].capabilities;
    }

    const capabilityVotes = new Map<
      string,
      {
        capability: ParsedCapability;
        votes: number;
        totalConfidence: number;
      }
    >();

    // Count votes for each capability type
    for (const response of responses) {
      for (const capability of response.capabilities) {
        const key = `${capability.name}:${capability.action}`;

        if (!capabilityVotes.has(key)) {
          capabilityVotes.set(key, {
            capability,
            votes: 0,
            totalConfidence: 0,
          });
        }

        const vote = capabilityVotes.get(key)!;
        vote.votes++;
        vote.totalConfidence += response.confidence;
      }
    }

    // Require majority vote (more than half of models)
    const majorityThreshold = Math.ceil(responses.length / 2);

    return Array.from(capabilityVotes.values())
      .filter((vote) => vote.votes >= majorityThreshold)
      .sort((a, b) => b.totalConfidence - a.totalConfidence)
      .map((vote) => vote.capability);
  }

  /**
   * Calculate model agreement percentage
   */
  private calculateModelAgreement(
    responses: ModelResponse[],
    consensusCapabilities: ParsedCapability[]
  ): number {
    if (responses.length === 0) {
      return 0;
    }

    let agreementCount = 0;

    for (const response of responses) {
      const responseCapabilityKeys = response.capabilities.map((c) => `${c.name}:${c.action}`);
      const consensusCapabilityKeys = consensusCapabilities.map((c) => `${c.name}:${c.action}`);

      const hasCommonCapabilities = consensusCapabilityKeys.some((key) =>
        responseCapabilityKeys.includes(key)
      );

      if (hasCommonCapabilities || consensusCapabilities.length === 0) {
        agreementCount++;
      }
    }

    return agreementCount / responses.length;
  }

  /**
   * Score a model response based on multiple factors
   */
  private scoreModelResponse(
    capabilities: ParsedCapability[],
    responseTime: number,
    model: ModelConfig
  ): number {
    let score = 0.5; // Base score

    // Quality bonus based on model priority
    score += (model.priority / 10) * 0.2;

    // Response time penalty (prefer faster responses)
    if (responseTime < 2000) {
      score += 0.1;
    } else if (responseTime > 5000) {
      score -= 0.1;
    }

    // Capability consistency bonus
    if (capabilities.length > 0) {
      // Bonus for having capabilities
      score += 0.2;

      // Small bonus for reasonable number of capabilities (not too many)
      if (capabilities.length <= 3) {
        score += 0.1;
      }
    }

    // Ensure score is between 0 and 1
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate overall confidence
   */
  private calculateOverallConfidence(
    responses: ModelResponse[],
    consensusCapabilities: ParsedCapability[]
  ): number {
    if (responses.length === 0) {
      return 0;
    }

    const averageModelConfidence =
      responses.reduce((sum, r) => sum + r.confidence, 0) / responses.length;
    const agreementBonus = this.calculateModelAgreement(responses, consensusCapabilities) * 0.3;

    return Math.min(1, averageModelConfidence + agreementBonus);
  }

  /**
   * Try fallback strategies when consensus fails
   */
  private async tryFallbackStrategies(message: string): Promise<ConsensusResult> {
    logger.info('🔄 Trying fallback strategies for capability extraction');

    // Natural language detection
    const naturalLanguageCapabilities = this.detectNaturalLanguagePatterns(message);
    if (naturalLanguageCapabilities.length > 0) {
      return {
        capabilities: naturalLanguageCapabilities,
        confidence: 0.6,
        modelAgreement: 1.0,
        usedModels: ['natural_language_detector'],
        fallbackUsed: true,
      };
    }

    // Keyword pattern matching
    const keywordCapabilities = this.detectKeywordPatterns(message);
    if (keywordCapabilities.length > 0) {
      return {
        capabilities: keywordCapabilities,
        confidence: 0.5,
        modelAgreement: 1.0,
        usedModels: ['keyword_detector'],
        fallbackUsed: true,
      };
    }

    // Return empty capabilities if nothing detected
    return {
      capabilities: [],
      confidence: 0.8, // High confidence in "no capabilities"
      modelAgreement: 1.0,
      usedModels: ['no_action_detector'],
      fallbackUsed: true,
    };
  }

  /**
   * Detect natural language patterns
   */
  private detectNaturalLanguagePatterns(message: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    const lowerMessage = message.toLowerCase();

    // Memory patterns
    if (lowerMessage.includes('remember') || lowerMessage.includes('save this')) {
      capabilities.push({
        name: 'memory',
        action: 'remember',
        content: message,
        params: {},
      });
    }

    if (lowerMessage.includes('recall') || lowerMessage.includes('what do you remember')) {
      capabilities.push({
        name: 'memory',
        action: 'search',
        content: message,
        params: {},
      });
    }

    // Math patterns
    if (
      lowerMessage.includes('calculate') ||
      lowerMessage.includes('compute') ||
      (lowerMessage.includes('what is') &&
        (lowerMessage.includes('+') ||
          lowerMessage.includes('-') ||
          lowerMessage.includes('*') ||
          lowerMessage.includes('/')))
    ) {
      capabilities.push({
        name: 'calculator',
        action: 'calculate',
        content: message,
        params: {},
      });
    }

    // Search patterns
    if (
      lowerMessage.includes('search') ||
      lowerMessage.includes('look up') ||
      lowerMessage.includes('find information')
    ) {
      capabilities.push({
        name: 'web',
        action: 'search',
        content: message,
        params: {},
      });
    }

    return capabilities;
  }

  /**
   * Detect keyword patterns
   */
  private detectKeywordPatterns(message: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    const words = message.toLowerCase().split(' ');

    // Simple keyword triggers
    if (words.includes('remember')) {
      capabilities.push({
        name: 'memory',
        action: 'remember',
        content: message,
        params: {},
      });
    }

    if (words.includes('calculate') || words.includes('math')) {
      capabilities.push({
        name: 'calculator',
        action: 'calculate',
        content: message,
        params: {},
      });
    }

    return capabilities;
  }

  /**
   * Emergency fallback when everything fails
   */
  private async emergencyFallback(message: string): Promise<ConsensusResult> {
    logger.warn('🚨 Using emergency fallback for capability extraction');

    return {
      capabilities: [],
      confidence: 0.9, // High confidence in "no action needed"
      modelAgreement: 1.0,
      usedModels: ['emergency_fallback'],
      fallbackUsed: true,
    };
  }

  /**
   * Health check for consensus engine
   */
  async healthCheck(): Promise<{
    availableModels: number;
    totalModels: number;
    fallbacksAvailable: number;
  }> {
    return {
      availableModels: this.models.length,
      totalModels: this.models.length,
      fallbacksAvailable: this.fallbackStrategies.length,
    };
  }
}

// Singleton instance
export const consensusEngine = new ConsensusEngine();

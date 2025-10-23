import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { openRouterModelsService } from '../services/openrouter-models.js';

const router: Router = Router();

// GET /api/models - Get current active models with live OpenRouter data
router.get('/', async (req: Request, res: Response) => {
  try {
    // Import OpenRouter service dynamically to avoid circular dependencies
    const { openRouterService } = await import('../index.js');

    const availableModels = openRouterService.getAvailableModels();
    const currentModel = openRouterService.getCurrentModel();

    // Get enhanced model data from OpenRouter API
    const enhancedModels = await openRouterModelsService.getEnhancedModelData(
      availableModels,
      currentModel
    );

    // Get summary statistics
    const summary = await openRouterModelsService.getModelSummary(availableModels);

    res.json({
      success: true,
      data: {
        currentModel,
        summary,
        models: enhancedModels,
        // Legacy format for backward compatibility
        totalModels: availableModels.length,
        all: enhancedModels.map((model) => ({
          name: model.id,
          category: model.isFree ? 'free' : 'premium',
          tier: model.modality === 'text' ? 'standard' : 'multimodal',
          provider: model.provider,
          model: model.name,
          active: model.isActive,
        })),
      },
    });
  } catch (error) {
    logger.error('Error fetching models with OpenRouter data:', error);

    // Check if it's a configuration issue
    const { openRouterService } = await import('../index.js');
    const configuredModels = openRouterService.getAvailableModels();

    res.status(500).json({
      success: false,
      error: 'Failed to fetch model information from OpenRouter',
      details: error instanceof Error ? error.message : String(error),
      configuredModels,
      hint: 'Check if OPENROUTER_MODELS contains valid model names from https://openrouter.ai/models',
    });
  }
});

// GET /api/models/summary - Get quick model pool summary
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const { openRouterService } = await import('../index.js');
    const availableModels = openRouterService.getAvailableModels();
    const summary = await openRouterModelsService.getModelSummary(availableModels);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    logger.error('Error fetching model summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch model summary',
    });
  }
});

export default router;

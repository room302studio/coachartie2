import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });
import { openRouterModelsService } from '../4-generate/model-catalog.js';

const router: Router = Router();

// GET /api/models - Get current active models with live OpenRouter data
router.get('/', async (_req: Request, res: Response) => sendResult(res, await listModels()));

// GET /api/models/summary - Get quick model pool summary
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const { openRouterService } = await import('../4-generate/openrouter.js');
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

/** GET /api/models's body: the active model pool with live OpenRouter data. */
export async function listModels(): Promise<ApiResult> {
  try {
    // Import OpenRouter service dynamically to avoid circular dependencies. From its own
    // module, not main.js: main.js only re-exported it, and importing main boots the engine.
    const { openRouterService } = await import('../4-generate/openrouter.js');

    const availableModels = openRouterService.getAvailableModels();
    const currentModel = openRouterService.getCurrentModel();

    // Get enhanced model data from OpenRouter API
    const enhancedModels = await openRouterModelsService.getEnhancedModelData(
      availableModels,
      currentModel
    );

    // Get summary statistics
    const summary = await openRouterModelsService.getModelSummary(availableModels);

    return reply(200, {
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
    const { openRouterService } = await import('../4-generate/openrouter.js');
    const configuredModels = openRouterService.getAvailableModels();

    return reply(500, {
      success: false,
      error: 'Failed to fetch model information from OpenRouter',
      details: error instanceof Error ? error.message : String(error),
      configuredModels,
      hint: 'Check if OPENROUTER_MODELS contains valid model names from https://openrouter.ai/models',
    });
  }
}

export default router;

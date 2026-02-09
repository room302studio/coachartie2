/**
 * Context Alchemy - Observability & Experimentation
 *
 * Core services for understanding what happens inside Artie's "mind":
 * - TraceManager: Track every generation with timing, context metrics, feedback
 * - ExperimentManager: A/B test models, prompts, and configurations
 *
 * Usage:
 *   import { traceManager, experimentManager } from './context-alchemy';
 */

export { traceManager, TraceManager } from './trace-manager.js';
export type {
  TraceCreateData,
  TraceUpdateData,
  ContextSnapshotData,
  TraceFeedback,
} from './trace-manager.js';

export { experimentManager, ExperimentManager } from './experiment-manager.js';
export type {
  VariantType,
  ExperimentStatus,
  TargetType,
  VariantConfig,
  ExperimentDefinition,
  ExperimentResults,
  VariantAssignment,
} from './experiment-manager.js';

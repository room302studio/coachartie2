import { IncomingMessage } from '@coachartie/shared';

// =====================================================
// ORCHESTRATION TYPES
// Shared types for capability orchestration system
// =====================================================

export interface ExtractedCapability {
  name: string;
  action: string;
  params: Record<string, unknown>;
  content?: string;
  priority: number;
}

export interface CapabilityResult {
  capability: ExtractedCapability;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: string;
}

export interface OrchestrationContext {
  messageId: string;
  userId: string;
  originalMessage: string;
  source: string;
  capabilities: ExtractedCapability[];
  results: CapabilityResult[];
  currentStep: number;
  respondTo: IncomingMessage['respondTo'];
  capabilityFailureCount: Map<string, number>; // Circuit breaker: track failures per capability
  discord_context?: any; // Discord-specific context for mention resolution, etc.

  /**
   * Absolute wall-clock ms (Date.now()) by which this job must produce words.
   *
   * An absolute deadline rather than a duration, because durations measured from different
   * zero points silently overrun: the loop's own "150s budget" started when the LOOP started,
   * while the consumer's 180s kill started when the JOB started. Everything before the loop —
   * context building, the first LLM call, capability execution — was free time the loop never
   * counted, so its soft deadline could land AFTER the hard kill and never fire. A deadline
   * every component compares against has one zero point and can't drift.
   */
  deadlineAt?: number;

  // Security: Taint tracking for external content
  // When true, dangerous capabilities (shell, fs write, git) are blocked
  // to prevent prompt injection from external sources like moltbook
  taintedByExternalContent?: boolean;
  taintSource?: string; // Which capability caused the taint

  // Context Alchemy: Observability trace ID
  // Links this orchestration to a generation trace for analytics
  traceId?: string | null;
}

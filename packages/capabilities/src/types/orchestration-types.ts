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

  // Security: Taint tracking for external content
  // When true, dangerous capabilities (shell, fs write, git) are blocked
  // to prevent prompt injection from external sources like moltbook
  taintedByExternalContent?: boolean;
  taintSource?: string; // Which capability caused the taint
}

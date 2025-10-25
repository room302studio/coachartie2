/**
 * Mention Proxy System
 *
 * Allows Artie to act as a representative/proxy for specific users in specific contexts.
 * Examples:
 * - Answer questions when @ejfox is mentioned in Subway Builder guild
 * - Act as team representative in public servers
 * - Handle common questions for busy people
 */

export type ResponseMode =
  | 'direct'      // Answer directly without announcing proxy
  | 'announced'   // "Answering for @user: ..."
  | 'assistant';  // "I can help while @user is away..."

export type TriggerType =
  | 'any_mention'     // Respond to any mention
  | 'questions_only'  // Only respond to questions
  | 'keywords';       // Only respond if specific keywords present

export interface MentionProxyRule {
  // Unique identifier
  id: string;

  // Who to represent
  targetUserId: string;          // Discord user ID to monitor
  targetUsername: string;         // For display/logging

  // Where to respond
  guildId: string;               // Which guild this applies to
  guildName?: string;            // Optional: for display
  channelIds?: string[];         // Optional: specific channels only

  // How to respond
  responseMode: ResponseMode;
  responseStyle?: string;        // Optional: custom system prompt context

  // When to respond
  triggerType: TriggerType;
  keywords?: string[];           // For keyword-based triggers

  // Control
  enabled: boolean;

  // Metadata
  name: string;                  // Human-friendly name
  description?: string;          // What this rule is for
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  createdBy?: string;            // Discord user ID who created it
}

export interface MentionProxyConfig {
  rules: MentionProxyRule[];
  version: string;
}

/**
 * Default empty configuration
 */
export const DEFAULT_CONFIG: MentionProxyConfig = {
  rules: [],
  version: '1.0.0',
};

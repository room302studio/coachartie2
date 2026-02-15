/**
 * Unified Database Schema for CoachArtie
 *
 * This is the SINGLE SOURCE OF TRUTH for all database schemas.
 * All packages must use these schemas - no exceptions.
 *
 * To add a new table:
 * 1. Add the table definition here
 * 2. Export it from this file
 * 3. Run `pnpm db:generate` to create a migration
 * 4. Run `pnpm db:migrate` to apply the migration
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================================================
// CORE TABLES
// ============================================================================

/**
 * Memories - The heart of CoachArtie's memory system
 */
export const memories = sqliteTable(
  'memories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    content: text('content').notNull(),
    tags: text('tags').notNull().default('[]'), // JSON array
    context: text('context').default(''),
    timestamp: text('timestamp').notNull(),
    importance: integer('importance').default(5),
    metadata: text('metadata').default('{}'), // JSON object
    embedding: text('embedding'),
    relatedMessageId: text('related_message_id'),
    guildId: text('guild_id'), // Discord guild scope (null = user-level or global)
    channelId: text('channel_id'), // Discord channel scope (null = guild-level or broader)
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_memories_user_id').on(table.userId),
    timestampIdx: index('idx_memories_timestamp').on(table.timestamp),
    importanceIdx: index('idx_memories_importance').on(table.importance),
    guildIdIdx: index('idx_memories_guild_id').on(table.guildId),
  })
);

/**
 * Messages - Chat history and interactions
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    value: text('value').notNull(),
    userId: text('user_id').notNull(),
    messageType: text('message_type').default('discord'),
    channelId: text('channel_id'),
    guildId: text('guild_id'),
    conversationId: text('conversation_id'),
    role: text('role'),
    memoryId: integer('memory_id'),
    relatedMessageId: text('related_message_id'),
    metadata: text('metadata').default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_messages_user_id').on(table.userId),
    createdAtIdx: index('idx_messages_created_at').on(table.createdAt),
  })
);

/**
 * Prompts - System prompts and templates
 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    description: text('description'),
    category: text('category').default('general'),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    metadata: text('metadata').default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameActiveIdx: index('idx_prompts_name_active').on(table.name, table.isActive),
    categoryIdx: index('idx_prompts_category').on(table.category),
  })
);

/**
 * Prompt History - Track changes to prompts
 */
export const promptHistory = sqliteTable('prompt_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  promptId: integer('prompt_id')
    .notNull()
    .references(() => prompts.id),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  changedBy: text('changed_by'),
  changeReason: text('change_reason'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// ============================================================================
// TASK MANAGEMENT & QUEUE
// ============================================================================

/**
 * Queue - Job queue for async task processing
 */
export const queue = sqliteTable(
  'queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    status: text('status').default('pending'), // pending, processing, completed, failed, cancelled
    taskType: text('task_type').notNull(),
    priority: integer('priority').default(0),
    payload: text('payload').default('{}'), // JSON
    result: text('result'), // JSON
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').default(0),
    maxRetries: integer('max_retries').default(3),
    assignedTo: text('assigned_to'), // Worker ID
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    statusIdx: index('idx_queue_status').on(table.status),
    createdAtIdx: index('idx_queue_created_at').on(table.createdAt),
    priorityIdx: index('idx_queue_priority').on(table.priority),
    taskTypeIdx: index('idx_queue_task_type').on(table.taskType),
  })
);

/**
 * Todos - Simple todo task tracking
 */
export const todos = sqliteTable(
  'todos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id'),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').default('pending'), // pending, in_progress, completed, cancelled
    priority: integer('priority').default(0),
    dueDate: text('due_date'),
    completedAt: text('completed_at'),
    data: text('data').default('{}'), // JSON
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userStatusIdx: index('idx_todos_user_status').on(table.userId, table.status),
  })
);

/**
 * Todo Lists - Collections of todo items
 */
export const todoLists = sqliteTable(
  'todo_lists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    goalId: integer('goal_id'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_todo_lists_user_id').on(table.userId),
    userNameUnique: index('idx_todo_lists_user_name').on(table.userId, table.name),
  })
);

/**
 * Todo Items - Individual items within a todo list
 */
export const todoItems = sqliteTable(
  'todo_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listId: integer('list_id')
      .notNull()
      .references(() => todoLists.id),
    content: text('content').notNull(),
    status: text('status').default('pending'),
    position: integer('position').notNull(),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    completedAt: text('completed_at'),
  },
  (table) => ({
    listIdIdx: index('idx_todo_items_list_id').on(table.listId),
    statusIdx: index('idx_todo_items_status').on(table.status),
  })
);

/**
 * Goals - Long-term objectives and goal tracking
 */
export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id'),
    title: text('title').notNull(),
    objective: text('objective'),
    description: text('description'),
    targetDate: text('target_date'),
    deadline: text('deadline'),
    status: text('status').default('active'), // active, paused, completed, abandoned, not_started
    priority: integer('priority').default(5),
    progress: integer('progress').default(0), // 0-100
    milestones: text('milestones').default('[]'), // JSON array
    metadata: text('metadata').default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
    completedAt: text('completed_at'),
  },
  (table) => ({
    userIdIdx: index('idx_goals_user_id').on(table.userId),
    statusIdx: index('idx_goals_status').on(table.status),
    deadlineIdx: index('idx_goals_deadline').on(table.deadline),
    userStatusIdx: index('idx_goals_user_status').on(table.userId, table.status),
  })
);

/**
 * User Identities - Cross-platform user identification
 */
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    discordId: text('discord_id').unique(),
    phoneNumber: text('phone_number').unique(),
    email: text('email').unique(),
    displayName: text('display_name').notNull(),
    preferredChannel: text('preferred_channel').default('discord'),
    metadata: text('metadata').default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    discordIdIdx: index('idx_user_identities_discord_id').on(table.discordId),
    phoneNumberIdx: index('idx_user_identities_phone_number').on(table.phoneNumber),
    emailIdx: index('idx_user_identities_email').on(table.email),
  })
);

// ============================================================================
// CAPABILITIES & CONFIG
// ============================================================================

/**
 * Capabilities Config - Per-capability configuration
 */
export const capabilitiesConfig = sqliteTable(
  'capabilities_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    version: integer('version').notNull().default(1),
    config: text('config').notNull(), // JSON
    description: text('description'),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true),
    metadata: text('metadata').default('{}'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameEnabledIdx: index('idx_capabilities_name_enabled').on(table.name, table.isEnabled),
  })
);

/**
 * Global Variables - Key-value store for system state
 */
export const globalVariables = sqliteTable('global_variables', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  valueType: text('value_type').default('string'),
  description: text('description'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Global Variables History - Track changes to variables
 */
export const globalVariablesHistory = sqliteTable('global_variables_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  valueType: text('value_type').default('string'),
  changedBy: text('changed_by').default('system'),
  changeReason: text('change_reason'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Config - Generic key-value configuration store
 */
export const config = sqliteTable('config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  configKey: text('config_key').notNull().unique(),
  configValue: text('config_value').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  history: text('history').default('{}'), // JSON
  notes: text('notes'),
});

/**
 * Logs - Application logs
 */
export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level'), // info, warn, error, debug
    message: text('message'),
    service: text('service'),
    timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    timestampIdx: index('idx_logs_timestamp').on(table.timestamp),
    levelIdx: index('idx_logs_level').on(table.level),
    serviceIdx: index('idx_logs_service').on(table.service),
  })
);

// ============================================================================
// USAGE & BILLING
// ============================================================================

/**
 * Model Usage Stats - Track LLM usage for billing/monitoring
 */
export const modelUsageStats = sqliteTable(
  'model_usage_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    modelName: text('model_name').notNull(),
    userId: text('user_id').notNull(),
    messageId: text('message_id'),
    inputLength: integer('input_length').default(0),
    outputLength: integer('output_length').default(0),
    responseTimeMs: integer('response_time_ms').default(0),
    capabilitiesDetected: integer('capabilities_detected').default(0),
    capabilitiesExecuted: integer('capabilities_executed').default(0),
    capabilityTypes: text('capability_types').default(''),
    success: integer('success', { mode: 'boolean' }).default(true),
    errorType: text('error_type'),
    promptTokens: integer('prompt_tokens').default(0),
    completionTokens: integer('completion_tokens').default(0),
    totalTokens: integer('total_tokens').default(0),
    estimatedCost: real('estimated_cost').default(0.0),
    timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userTimeIdx: index('idx_usage_user_time').on(table.userId, table.timestamp),
    modelTimeIdx: index('idx_usage_model_time').on(table.modelName, table.timestamp),
    timestampIdx: index('idx_usage_timestamp').on(table.timestamp),
  })
);

/**
 * Credit Balance - Track API credits
 */
export const creditBalance = sqliteTable(
  'credit_balance',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull().default('openrouter'),
    creditsRemaining: real('credits_remaining'),
    creditsUsed: real('credits_used'),
    dailySpend: real('daily_spend').default(0.0),
    monthlySpend: real('monthly_spend').default(0.0),
    rateLimitRemaining: integer('rate_limit_remaining'),
    rateLimitReset: text('rate_limit_reset'),
    lastUpdated: text('last_updated').default(sql`CURRENT_TIMESTAMP`),
    rawResponse: text('raw_response'),
  },
  (table) => ({
    providerTimeIdx: index('idx_credit_provider_time').on(table.provider, table.lastUpdated),
  })
);

/**
 * Credit Alerts - Low balance warnings
 */
export const creditAlerts = sqliteTable(
  'credit_alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertType: text('alert_type').notNull(),
    thresholdValue: real('threshold_value'),
    currentValue: real('current_value'),
    message: text('message'),
    severity: text('severity').default('info'),
    acknowledged: integer('acknowledged', { mode: 'boolean' }).default(false),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    typeTimeIdx: index('idx_alerts_type_time').on(table.alertType, table.createdAt),
  })
);

// ============================================================================
// OAUTH & AUTH
// ============================================================================

/**
 * OAuth Tokens - Third-party service tokens
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: text('expires_at'),
    scopes: text('scopes'),
    metadata: text('metadata'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userProviderIdx: index('idx_oauth_user_provider').on(table.userId, table.provider),
    expiresIdx: index('idx_oauth_expires').on(table.expiresAt),
  })
);

// ============================================================================
// MEETINGS & SCHEDULING
// ============================================================================

/**
 * Meetings - Scheduled meetings
 */
export const meetings = sqliteTable(
  'meetings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    scheduledTime: text('scheduled_time').notNull(),
    durationMinutes: integer('duration_minutes').default(30),
    timezone: text('timezone').default('UTC'),
    participants: text('participants').default('[]'), // JSON array
    status: text('status').default('scheduled'),
    createdVia: text('created_via').default('api'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_meetings_user_id').on(table.userId),
    scheduledTimeIdx: index('idx_meetings_scheduled_time').on(table.scheduledTime),
    statusIdx: index('idx_meetings_status').on(table.status),
  })
);

/**
 * Meeting Participants
 */
export const meetingParticipants = sqliteTable(
  'meeting_participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    meetingId: integer('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').notNull(),
    participantType: text('participant_type').default('email'),
    status: text('status').default('pending'),
    respondedAt: text('responded_at'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    meetingIdIdx: index('idx_meeting_participants_meeting_id').on(table.meetingId),
  })
);

/**
 * Meeting Reminders
 */
export const meetingReminders = sqliteTable(
  'meeting_reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    meetingId: integer('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    reminderTime: text('reminder_time').notNull(),
    sent: integer('sent', { mode: 'boolean' }).default(false),
    sentAt: text('sent_at'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    reminderTimeIdx: index('idx_meeting_reminders_reminder_time').on(table.reminderTime),
  })
);

// ============================================================================
// GITHUB SYNC
// ============================================================================

/**
 * GitHub Repo Watches - Maps GitHub repos to Discord channels
 */
export const githubRepoWatches = sqliteTable(
  'github_repo_watches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repo: text('repo').notNull(), // e.g., "owner/repo"
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    events: text('events').default('["all"]'), // JSON array: ["pr", "review", "ci"] or ["all"]
    settings: text('settings').default('{}'), // JSON: poll interval, filters, etc.
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    createdBy: text('created_by'), // Discord user ID who added this watch
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    repoIdx: index('idx_github_watches_repo').on(table.repo),
    guildIdx: index('idx_github_watches_guild').on(table.guildId),
    channelIdx: index('idx_github_watches_channel').on(table.channelId),
    repoChannelUnique: index('idx_github_watches_repo_channel').on(table.repo, table.channelId),
  })
);

/**
 * GitHub Sync State - Tracks last seen events per repo for polling
 */
export const githubSyncState = sqliteTable(
  'github_sync_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repo: text('repo').notNull().unique(), // e.g., "owner/repo"
    lastPrNumber: integer('last_pr_number').default(0),
    lastPrUpdatedAt: text('last_pr_updated_at'),
    lastCommentId: integer('last_comment_id').default(0),
    lastReviewId: integer('last_review_id').default(0),
    lastCheckRunId: integer('last_check_run_id').default(0),
    lastPolledAt: text('last_polled_at'),
    pollErrors: integer('poll_errors').default(0), // consecutive errors for backoff
    metadata: text('metadata').default('{}'), // JSON for additional state
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    repoIdx: index('idx_github_sync_repo').on(table.repo),
    lastPolledIdx: index('idx_github_sync_last_polled').on(table.lastPolledAt),
  })
);

/**
 * GitHub Identity Mappings - Maps GitHub usernames to Discord users
 * Learned organically by Artie, can be manually overridden
 */
export const githubIdentityMappings = sqliteTable(
  'github_identity_mappings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubUsername: text('github_username').notNull().unique(),
    discordUserId: text('discord_user_id'),
    displayName: text('display_name'), // Cached display name
    confidence: real('confidence').default(1.0), // 0-1, how confident Artie is in this mapping
    source: text('source').default('manual'), // manual, learned, heuristic
    metadata: text('metadata').default('{}'), // JSON for additional info
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    githubIdx: index('idx_github_identity_github').on(table.githubUsername),
    discordIdx: index('idx_github_identity_discord').on(table.discordUserId),
  })
);

/**
 * GitHub Events Queue - Pending events to be posted to Discord
 * Used for batching and deduplication
 */
export const githubEventsQueue = sqliteTable(
  'github_events_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repo: text('repo').notNull(),
    eventType: text('event_type').notNull(), // pr_opened, pr_ready, comment, review, ci_status, etc.
    eventId: text('event_id').notNull(), // Unique ID from GitHub (PR number, comment ID, etc.)
    channelId: text('channel_id').notNull(),
    payload: text('payload').notNull(), // JSON event data
    status: text('status').default('pending'), // pending, batched, posted, skipped
    batchKey: text('batch_key'), // For grouping related events
    priority: integer('priority').default(0),
    scheduledFor: text('scheduled_for'), // When to post (for batching delay)
    postedAt: text('posted_at'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    statusIdx: index('idx_github_events_status').on(table.status),
    repoIdx: index('idx_github_events_repo').on(table.repo),
    batchKeyIdx: index('idx_github_events_batch_key').on(table.batchKey),
    scheduledIdx: index('idx_github_events_scheduled').on(table.scheduledFor),
    eventIdIdx: index('idx_github_events_event_id').on(table.repo, table.eventType, table.eventId),
  })
);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;

export type CapabilityConfig = typeof capabilitiesConfig.$inferSelect;
export type NewCapabilityConfig = typeof capabilitiesConfig.$inferInsert;

export type GlobalVariable = typeof globalVariables.$inferSelect;
export type NewGlobalVariable = typeof globalVariables.$inferInsert;

export type ModelUsageStat = typeof modelUsageStats.$inferSelect;
export type NewModelUsageStat = typeof modelUsageStats.$inferInsert;

export type CreditBalance = typeof creditBalance.$inferSelect;
export type NewCreditBalance = typeof creditBalance.$inferInsert;

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;

export type QueueItem = typeof queue.$inferSelect;
export type NewQueueItem = typeof queue.$inferInsert;

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

export type TodoList = typeof todoLists.$inferSelect;
export type NewTodoList = typeof todoLists.$inferInsert;

export type TodoItem = typeof todoItems.$inferSelect;
export type NewTodoItem = typeof todoItems.$inferInsert;

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;

export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;

export type Config = typeof config.$inferSelect;
export type NewConfig = typeof config.$inferInsert;

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;

export type GithubRepoWatch = typeof githubRepoWatches.$inferSelect;
export type NewGithubRepoWatch = typeof githubRepoWatches.$inferInsert;

export type GithubSyncState = typeof githubSyncState.$inferSelect;
export type NewGithubSyncState = typeof githubSyncState.$inferInsert;

export type GithubIdentityMapping = typeof githubIdentityMappings.$inferSelect;
export type NewGithubIdentityMapping = typeof githubIdentityMappings.$inferInsert;

export type GithubEvent = typeof githubEventsQueue.$inferSelect;
export type NewGithubEvent = typeof githubEventsQueue.$inferInsert;

// ============================================================================
// REFLECTION & LEARNING
// ============================================================================

/**
 * Learned Rules - Consolidated learnings from community feedback
 * Stores actionable rules extracted from reaction feedback patterns
 */
export const learnedRules = sqliteTable(
  'learned_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleType: text('rule_type').notNull(), // 'guild' | 'system' | 'channel'
    scopeId: text('scope_id'), // guildId, channelId, or null for system-wide
    ruleText: text('rule_text').notNull(), // The actual instruction
    sourceTag: text('source_tag'), // 'response-style', 'format', 'tone', etc.
    confidence: real('confidence').default(0.5), // 0.0-1.0 based on feedback volume
    sourceCount: integer('source_count').default(1), // How many feedback items informed this
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    metadata: text('metadata').default('{}'), // JSON: examples, counter-examples
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    ruleTypeIdx: index('idx_learned_rules_type').on(table.ruleType),
    scopeIdIdx: index('idx_learned_rules_scope').on(table.scopeId),
    activeIdx: index('idx_learned_rules_active').on(table.isActive),
    typeScopeActiveIdx: index('idx_learned_rules_type_scope_active').on(
      table.ruleType,
      table.scopeId,
      table.isActive
    ),
  })
);

/**
 * Learned Rules History - Track changes to rules for versioning
 */
export const learnedRulesHistory = sqliteTable(
  'learned_rules_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleId: integer('rule_id')
      .notNull()
      .references(() => learnedRules.id, { onDelete: 'cascade' }),
    ruleText: text('rule_text').notNull(),
    confidence: real('confidence'),
    sourceCount: integer('source_count'),
    changeType: text('change_type').notNull(), // 'created' | 'updated' | 'retired' | 'reactivated'
    changeReason: text('change_reason'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    ruleIdIdx: index('idx_learned_rules_history_rule_id').on(table.ruleId),
    createdAtIdx: index('idx_learned_rules_history_created').on(table.createdAt),
  })
);

export type LearnedRule = typeof learnedRules.$inferSelect;
export type NewLearnedRule = typeof learnedRules.$inferInsert;

export type LearnedRuleHistory = typeof learnedRulesHistory.$inferSelect;
export type NewLearnedRuleHistory = typeof learnedRulesHistory.$inferInsert;

// ============================================================================
// CONTEXT ALCHEMY - OBSERVABILITY & EXPERIMENTATION
// ============================================================================

/**
 * Generation Traces - Core observability table for every LLM generation
 * Tracks timing, context metrics, model selection, and feedback correlation
 */
export const generationTraces = sqliteTable(
  'generation_traces',
  {
    id: text('id').primaryKey(), // UUID
    messageId: text('message_id').notNull(),
    discordMessageId: text('discord_message_id'), // For feedback correlation
    userId: text('user_id').notNull(),
    guildId: text('guild_id'),
    channelId: text('channel_id'),

    // Timing
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    durationMs: integer('duration_ms'),

    // Model
    modelUsed: text('model_used'),
    modelTier: text('model_tier'), // 'fast', 'smart', 'manager'

    // Context metrics
    contextTokenCount: integer('context_token_count'),
    memoriesRetrievedCount: integer('memories_retrieved_count').default(0),
    rulesAppliedCount: integer('rules_applied_count').default(0),
    rulesAppliedIds: text('rules_applied_ids').default('[]'), // JSON array of rule IDs

    // Response
    responseLength: integer('response_length'),
    responseTokens: integer('response_tokens'),
    estimatedCost: real('estimated_cost'),

    // Experiment
    experimentId: text('experiment_id'),
    variantId: text('variant_id'),

    // Feedback (updated async when reaction received)
    feedbackSentiment: text('feedback_sentiment'), // 'positive' | 'negative' | null
    feedbackEmoji: text('feedback_emoji'),
    feedbackAt: text('feedback_at'),

    // Status
    success: integer('success', { mode: 'boolean' }).default(true),
    errorType: text('error_type'),
  },
  (table) => ({
    messageIdIdx: index('idx_traces_message_id').on(table.messageId),
    discordMsgIdx: index('idx_traces_discord_msg').on(table.discordMessageId),
    userIdIdx: index('idx_traces_user_id').on(table.userId),
    guildIdIdx: index('idx_traces_guild_id').on(table.guildId),
    startedAtIdx: index('idx_traces_started_at').on(table.startedAt),
    experimentIdx: index('idx_traces_experiment').on(table.experimentId, table.variantId),
    feedbackIdx: index('idx_traces_feedback').on(table.feedbackSentiment),
    modelIdx: index('idx_traces_model').on(table.modelUsed),
  })
);

/**
 * Context Snapshots - Full context captures for debugging (sampled)
 * Stores complete context for a subset of traces to enable deep analysis
 */
export const contextSnapshots = sqliteTable(
  'context_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    traceId: text('trace_id')
      .notNull()
      .references(() => generationTraces.id, { onDelete: 'cascade' }),

    systemPrompt: text('system_prompt'),
    contextSourcesJson: text('context_sources_json'), // Full ContextSource[] as JSON
    messageChainJson: text('message_chain_json'), // Messages sent to LLM as JSON
    fullResponse: text('full_response'), // Complete LLM response

    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    traceIdIdx: index('idx_snapshots_trace_id').on(table.traceId),
    createdAtIdx: index('idx_snapshots_created_at').on(table.createdAt),
  })
);

/**
 * Experiments - A/B test definitions
 * Defines experiments to test different models, prompts, or parameters
 */
export const experiments = sqliteTable(
  'experiments',
  {
    id: text('id').primaryKey(), // UUID or slug
    name: text('name').notNull(),
    hypothesis: text('hypothesis'), // What we're trying to prove

    targetType: text('target_type').notNull(), // 'global' | 'guild' | 'user'
    targetIds: text('target_ids').default('[]'), // JSON array of specific targets (empty = all)

    status: text('status').default('draft'), // 'draft' | 'active' | 'completed' | 'cancelled'
    trafficPercent: integer('traffic_percent').default(100), // % of eligible traffic to include

    startedAt: text('started_at'),
    endedAt: text('ended_at'),

    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    statusIdx: index('idx_experiments_status').on(table.status),
    targetTypeIdx: index('idx_experiments_target_type').on(table.targetType),
  })
);

/**
 * Experiment Variants - Individual variants within an experiment
 * Each variant defines a specific configuration to test
 */
export const experimentVariants = sqliteTable(
  'experiment_variants',
  {
    id: text('id').primaryKey(), // UUID
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // 'control', 'treatment_a', etc.

    variantType: text('variant_type').notNull(), // 'model' | 'prompt' | 'parameter' | 'feature'
    variantConfig: text('variant_config').notNull(), // JSON configuration

    weight: integer('weight').default(50), // Traffic weight for this variant

    // Stats (updated as traces complete)
    impressions: integer('impressions').default(0),
    positiveCount: integer('positive_count').default(0),
    negativeCount: integer('negative_count').default(0),

    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    experimentIdIdx: index('idx_variants_experiment_id').on(table.experimentId),
    nameIdx: index('idx_variants_name').on(table.experimentId, table.name),
  })
);

// ============================================================================
// EVAL SUITE - Test Sets & Prompts (Versioned)
// ============================================================================

/**
 * Test Sets - Named collections of test prompts
 * Each test set is versioned so eval runs can reference specific versions
 */
export const testSets = sqliteTable(
  'test_sets',
  {
    id: text('id').primaryKey(), // UUID
    name: text('name').notNull(),
    description: text('description'),
    version: integer('version').notNull().default(1),

    // Metadata
    createdBy: text('created_by'), // user/system that created it
    isDefault: integer('is_default', { mode: 'boolean' }).default(false),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),

    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameVersionIdx: index('idx_test_sets_name_version').on(table.name, table.version),
    isDefaultIdx: index('idx_test_sets_is_default').on(table.isDefault),
  })
);

/**
 * Test Prompts - Individual prompts within a test set
 * Versioned along with their parent test set
 */
export const testPrompts = sqliteTable(
  'test_prompts',
  {
    id: text('id').primaryKey(), // UUID
    testSetId: text('test_set_id')
      .notNull()
      .references(() => testSets.id, { onDelete: 'cascade' }),

    promptKey: text('prompt_key').notNull(), // e.g., 'fact-1', 'reasoning-2'
    category: text('category').notNull(), // 'factual', 'reasoning', 'creative', etc.
    difficulty: text('difficulty').default('medium'), // 'easy', 'medium', 'hard'

    prompt: text('prompt').notNull(), // The actual prompt text
    context: text('context'), // Optional context/system prompt additions
    expectedBehavior: text('expected_behavior'), // What a good response should include

    // For ordering
    position: integer('position').default(0),

    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    testSetIdIdx: index('idx_test_prompts_test_set_id').on(table.testSetId),
    categoryIdx: index('idx_test_prompts_category').on(table.category),
    promptKeyIdx: index('idx_test_prompts_key').on(table.testSetId, table.promptKey),
  })
);

/**
 * Eval Runs - Records of proactive evaluation runs
 * Links to a specific test set version
 */
export const evalRuns = sqliteTable(
  'eval_runs',
  {
    id: text('id').primaryKey(), // UUID
    name: text('name').notNull(),

    testSetId: text('test_set_id').references(() => testSets.id),
    testSetVersion: integer('test_set_version'), // Snapshot of version at run time

    conditionsJson: text('conditions_json').notNull(), // JSON array of Condition objects
    promptCount: integer('prompt_count').notNull(),
    generationCount: integer('generation_count').default(0),
    judgmentCount: integer('judgment_count').default(0),

    resultsJson: text('results_json'), // JSON summary of results

    judgeModel: text('judge_model'), // Which model judged

    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => ({
    testSetIdIdx: index('idx_eval_runs_test_set_id').on(table.testSetId),
    startedAtIdx: index('idx_eval_runs_started_at').on(table.startedAt),
  })
);

/**
 * Eval Generations - Individual responses generated during eval
 */
export const evalGenerations = sqliteTable(
  'eval_generations',
  {
    id: text('id').primaryKey(), // UUID
    runId: text('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),

    promptId: text('prompt_id').notNull(), // Key like 'fact-1'
    conditionId: text('condition_id').notNull(),

    prompt: text('prompt').notNull(),
    response: text('response').notNull(),

    latencyMs: integer('latency_ms').notNull(),
    tokenCount: integer('token_count'),

    generatedAt: text('generated_at').notNull(),
  },
  (table) => ({
    runIdIdx: index('idx_eval_generations_run_id').on(table.runId),
    promptConditionIdx: index('idx_eval_generations_prompt_condition').on(
      table.runId,
      table.promptId,
      table.conditionId
    ),
  })
);

/**
 * Eval Judgments - Pairwise comparisons from LLM-as-judge
 */
export const evalJudgments = sqliteTable(
  'eval_judgments',
  {
    id: text('id').primaryKey(), // UUID
    runId: text('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),

    promptId: text('prompt_id').notNull(),
    conditionA: text('condition_a').notNull(),
    conditionB: text('condition_b').notNull(),
    generationA: text('generation_a').notNull(),
    generationB: text('generation_b').notNull(),

    winner: text('winner').notNull(), // 'A', 'B', or 'tie'
    confidence: integer('confidence').notNull(), // 1-5
    reasoning: text('reasoning'),

    judgeModel: text('judge_model').notNull(),
    judgedAt: text('judged_at').notNull(),
  },
  (table) => ({
    runIdIdx: index('idx_eval_judgments_run_id').on(table.runId),
    winnerIdx: index('idx_eval_judgments_winner').on(table.runId, table.winner),
  })
);

// ============================================================================
// EXTENDED OBSERVABILITY - Sessions, Conversations, Errors
// ============================================================================

/**
 * Conversations - Groups messages into conversation threads
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    guildId: text('guild_id'),
    channelId: text('channel_id'),
    startedAt: text('started_at').notNull(),
    lastActivityAt: text('last_activity_at').notNull(),
    endedAt: text('ended_at'),
    messageCount: integer('message_count').default(0),
    turnCount: integer('turn_count').default(0),
    totalDurationMs: integer('total_duration_ms'),
    feedbackSentiment: text('feedback_sentiment'),
    positiveReactions: integer('positive_reactions').default(0),
    negativeReactions: integer('negative_reactions').default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_conversations_user_id').on(table.userId),
    channelIdIdx: index('idx_conversations_channel_id').on(table.channelId),
    startedAtIdx: index('idx_conversations_started_at').on(table.startedAt),
  })
);

/**
 * Capability Invocations - Track every capability execution
 */
export const capabilityInvocations = sqliteTable(
  'capability_invocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    traceId: text('trace_id'),
    capabilityName: text('capability_name').notNull(),
    action: text('action').notNull(),
    paramsJson: text('params_json'),
    resultJson: text('result_json'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    durationMs: integer('duration_ms'),
    success: integer('success', { mode: 'boolean' }).default(true),
    errorType: text('error_type'),
    errorMessage: text('error_message'),
    sequenceNumber: integer('sequence_number').default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    traceIdIdx: index('idx_cap_invocations_trace_id').on(table.traceId),
    capabilityIdx: index('idx_cap_invocations_capability').on(table.capabilityName, table.action),
    successIdx: index('idx_cap_invocations_success').on(table.success),
  })
);

/**
 * Memory Events - Track memory lifecycle (create, recall, pin, forget)
 */
export const memoryEvents = sqliteTable(
  'memory_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    memoryId: integer('memory_id').notNull(),
    eventType: text('event_type').notNull(),
    userId: text('user_id'),
    traceId: text('trace_id'),
    query: text('query'),
    relevanceScore: real('relevance_score'),
    detailsJson: text('details_json'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    memoryIdIdx: index('idx_memory_events_memory_id').on(table.memoryId),
    eventTypeIdx: index('idx_memory_events_event_type').on(table.eventType),
    createdAtIdx: index('idx_memory_events_created_at').on(table.createdAt),
  })
);

/**
 * Error Events - Structured error logging
 */
export const errorEvents = sqliteTable(
  'error_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    errorType: text('error_type').notNull(),
    errorCode: text('error_code'),
    severity: text('severity').default('error'),
    traceId: text('trace_id'),
    userId: text('user_id'),
    guildId: text('guild_id'),
    service: text('service').notNull(),
    message: text('message'),
    stackTrace: text('stack_trace'),
    contextJson: text('context_json'),
    recovered: integer('recovered', { mode: 'boolean' }).default(false),
    recoveryAction: text('recovery_action'),
    retryCount: integer('retry_count').default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    errorTypeIdx: index('idx_error_events_type').on(table.errorType),
    serviceIdx: index('idx_error_events_service').on(table.service),
    severityIdx: index('idx_error_events_severity').on(table.severity),
    createdAtIdx: index('idx_error_events_created_at').on(table.createdAt),
  })
);

/**
 * User Sessions - Track user engagement sessions
 */
export const userSessions = sqliteTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    guildId: text('guild_id'),
    startedAt: text('started_at').notNull(),
    lastActivityAt: text('last_activity_at').notNull(),
    endedAt: text('ended_at'),
    messageCount: integer('message_count').default(0),
    conversationCount: integer('conversation_count').default(0),
    capabilityUsageCount: integer('capability_usage_count').default(0),
    totalDurationMs: integer('total_duration_ms'),
    avgResponseTimeMs: integer('avg_response_time_ms'),
    positiveReactions: integer('positive_reactions').default(0),
    negativeReactions: integer('negative_reactions').default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_user_sessions_user_id').on(table.userId),
    guildIdIdx: index('idx_user_sessions_guild_id').on(table.guildId),
    startedAtIdx: index('idx_user_sessions_started_at').on(table.startedAt),
    endedAtIdx: index('idx_user_sessions_ended_at').on(table.endedAt),
  })
);

// ============================================================================
// AUTONOMY - Objectives and Hired Tasks
// ============================================================================

/**
 * Objectives - Artie's persistent autonomous objectives
 * Not tasks, but directions Artie works toward over time
 * (Named 'objectives' to avoid conflict with legacy 'goals' table)
 */
export const objectives = sqliteTable(
  'objectives',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    goalType: text('goal_type').notNull(), // 'project', 'care', 'growth', 'watch', 'relationship', 'learning'
    successCriteria: text('success_criteria'),
    owner: text('owner').default('ej'),
    createdBy: text('created_by').default('ej'), // 'ej' or 'artie'
    status: text('status').default('active'), // 'dormant', 'active', 'blocked', 'achieved', 'abandoned'
    progress: integer('progress').default(0), // 0-100
    targetDate: text('target_date'),
    lastWorkedAt: text('last_worked_at'),
    achievedAt: text('achieved_at'),
    parentGoalId: text('parent_goal_id'),
    notes: text('notes'),
    blockers: text('blockers'),
    budgetEth: real('budget_eth'),
    budgetSpentEth: real('budget_spent_eth').default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    ownerIdx: index('idx_objectives_owner').on(table.owner),
    statusIdx: index('idx_objectives_status').on(table.status),
    goalTypeIdx: index('idx_objectives_goal_type').on(table.goalType),
    parentGoalIdx: index('idx_objectives_parent_goal_id').on(table.parentGoalId),
  })
);

/**
 * Goal Actions - Things Artie does for goals
 */
export const goalActions = sqliteTable(
  'goal_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goalId: text('goal_id').notNull(),
    actionType: text('action_type').notNull(), // 'reminder', 'check_in', 'research', 'hire', 'suggest', 'celebrate', 'progress_update'
    actionDescription: text('action_description'),
    result: text('result'),
    triggeredAt: text('triggered_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    goalIdIdx: index('idx_goal_actions_goal_id').on(table.goalId),
    actionTypeIdx: index('idx_goal_actions_action_type').on(table.actionType),
  })
);

/**
 * Hired Tasks - Work Artie delegates to humans or agents
 */
export const hiredTasks = sqliteTable(
  'hired_tasks',
  {
    id: text('id').primaryKey(),
    platform: text('platform').notNull(), // 'moltbook', 'mturk', 'freelancer'
    taskDescription: text('task_description').notNull(),
    taskType: text('task_type'), // 'research', 'judgment', 'creative', 'verification'
    budgetEth: real('budget_eth'),
    budgetUsd: real('budget_usd'),
    status: text('status').default('open'), // 'open', 'claimed', 'submitted', 'verified', 'paid', 'disputed'
    workerId: text('worker_id'),
    workerPlatformId: text('worker_platform_id'),
    result: text('result'),
    resultRating: integer('result_rating'), // 1-5
    parentGoalId: text('parent_goal_id'),
    postedAt: text('posted_at').default(sql`CURRENT_TIMESTAMP`),
    claimedAt: text('claimed_at'),
    submittedAt: text('submitted_at'),
    paidAt: text('paid_at'),
    txHash: text('tx_hash'),
  },
  (table) => ({
    platformIdx: index('idx_hired_tasks_platform').on(table.platform),
    statusIdx: index('idx_hired_tasks_status').on(table.status),
    parentGoalIdx: index('idx_hired_tasks_parent_goal_id').on(table.parentGoalId),
  })
);

export type Objective = typeof objectives.$inferSelect;
export type NewObjective = typeof objectives.$inferInsert;

export type GoalAction = typeof goalActions.$inferSelect;
export type NewGoalAction = typeof goalActions.$inferInsert;

export type HiredTask = typeof hiredTasks.$inferSelect;
export type NewHiredTask = typeof hiredTasks.$inferInsert;

export type GenerationTrace = typeof generationTraces.$inferSelect;
export type NewGenerationTrace = typeof generationTraces.$inferInsert;

export type ContextSnapshot = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshot = typeof contextSnapshots.$inferInsert;

export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

export type ExperimentVariant = typeof experimentVariants.$inferSelect;
export type NewExperimentVariant = typeof experimentVariants.$inferInsert;

export type TestSet = typeof testSets.$inferSelect;
export type NewTestSet = typeof testSets.$inferInsert;

export type TestPrompt = typeof testPrompts.$inferSelect;
export type NewTestPrompt = typeof testPrompts.$inferInsert;

export type EvalRun = typeof evalRuns.$inferSelect;
export type NewEvalRun = typeof evalRuns.$inferInsert;

export type EvalGeneration = typeof evalGenerations.$inferSelect;
export type NewEvalGeneration = typeof evalGenerations.$inferInsert;

export type EvalJudgment = typeof evalJudgments.$inferSelect;
export type NewEvalJudgment = typeof evalJudgments.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type CapabilityInvocation = typeof capabilityInvocations.$inferSelect;
export type NewCapabilityInvocation = typeof capabilityInvocations.$inferInsert;

export type MemoryEvent = typeof memoryEvents.$inferSelect;
export type NewMemoryEvent = typeof memoryEvents.$inferInsert;

export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;

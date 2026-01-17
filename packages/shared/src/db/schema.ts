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
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    userIdIdx: index('idx_memories_user_id').on(table.userId),
    timestampIdx: index('idx_memories_timestamp').on(table.timestamp),
    importanceIdx: index('idx_memories_importance').on(table.importance),
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

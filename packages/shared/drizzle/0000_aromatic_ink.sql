CREATE TABLE `capabilities_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	`description` text,
	`is_enabled` integer DEFAULT true,
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capabilities_config_name_unique` ON `capabilities_config` (`name`);--> statement-breakpoint
CREATE INDEX `idx_capabilities_name_enabled` ON `capabilities_config` (`name`,`is_enabled`);--> statement-breakpoint
CREATE TABLE `config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`config_key` text NOT NULL,
	`config_value` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`history` text DEFAULT '{}',
	`notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_config_key_unique` ON `config` (`config_key`);--> statement-breakpoint
CREATE TABLE `credit_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_type` text NOT NULL,
	`threshold_value` real,
	`current_value` real,
	`message` text,
	`severity` text DEFAULT 'info',
	`acknowledged` integer DEFAULT false,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_type_time` ON `credit_alerts` (`alert_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `credit_balance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text DEFAULT 'openrouter' NOT NULL,
	`credits_remaining` real,
	`credits_used` real,
	`daily_spend` real DEFAULT 0,
	`monthly_spend` real DEFAULT 0,
	`rate_limit_remaining` integer,
	`rate_limit_reset` text,
	`last_updated` text DEFAULT CURRENT_TIMESTAMP,
	`raw_response` text
);
--> statement-breakpoint
CREATE INDEX `idx_credit_provider_time` ON `credit_balance` (`provider`,`last_updated`);--> statement-breakpoint
CREATE TABLE `github_events_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`event_type` text NOT NULL,
	`event_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending',
	`batch_key` text,
	`priority` integer DEFAULT 0,
	`scheduled_for` text,
	`posted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_github_events_status` ON `github_events_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_github_events_repo` ON `github_events_queue` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_github_events_batch_key` ON `github_events_queue` (`batch_key`);--> statement-breakpoint
CREATE INDEX `idx_github_events_scheduled` ON `github_events_queue` (`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_github_events_event_id` ON `github_events_queue` (`repo`,`event_type`,`event_id`);--> statement-breakpoint
CREATE TABLE `github_identity_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_username` text NOT NULL,
	`discord_user_id` text,
	`display_name` text,
	`confidence` real DEFAULT 1,
	`source` text DEFAULT 'manual',
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_identity_mappings_github_username_unique` ON `github_identity_mappings` (`github_username`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_github` ON `github_identity_mappings` (`github_username`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_discord` ON `github_identity_mappings` (`discord_user_id`);--> statement-breakpoint
CREATE TABLE `github_repo_watches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`events` text DEFAULT '["all"]',
	`settings` text DEFAULT '{}',
	`is_active` integer DEFAULT true,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_github_watches_repo` ON `github_repo_watches` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_github_watches_guild` ON `github_repo_watches` (`guild_id`);--> statement-breakpoint
CREATE INDEX `idx_github_watches_channel` ON `github_repo_watches` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_github_watches_repo_channel` ON `github_repo_watches` (`repo`,`channel_id`);--> statement-breakpoint
CREATE TABLE `github_sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`last_pr_number` integer DEFAULT 0,
	`last_pr_updated_at` text,
	`last_comment_id` integer DEFAULT 0,
	`last_review_id` integer DEFAULT 0,
	`last_check_run_id` integer DEFAULT 0,
	`last_polled_at` text,
	`poll_errors` integer DEFAULT 0,
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_sync_state_repo_unique` ON `github_sync_state` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_github_sync_repo` ON `github_sync_state` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_github_sync_last_polled` ON `github_sync_state` (`last_polled_at`);--> statement-breakpoint
CREATE TABLE `global_variables` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`value_type` text DEFAULT 'string',
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `global_variables_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`value_type` text DEFAULT 'string',
	`changed_by` text DEFAULT 'system',
	`change_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`title` text NOT NULL,
	`objective` text,
	`description` text,
	`target_date` text,
	`deadline` text,
	`status` text DEFAULT 'active',
	`priority` integer DEFAULT 5,
	`progress` integer DEFAULT 0,
	`milestones` text DEFAULT '[]',
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_goals_user_id` ON `goals` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_goals_status` ON `goals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_goals_deadline` ON `goals` (`deadline`);--> statement-breakpoint
CREATE INDEX `idx_goals_user_status` ON `goals` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `learned_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_type` text NOT NULL,
	`scope_id` text,
	`rule_text` text NOT NULL,
	`source_tag` text,
	`confidence` real DEFAULT 0.5,
	`source_count` integer DEFAULT 1,
	`is_active` integer DEFAULT true,
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_learned_rules_type` ON `learned_rules` (`rule_type`);--> statement-breakpoint
CREATE INDEX `idx_learned_rules_scope` ON `learned_rules` (`scope_id`);--> statement-breakpoint
CREATE INDEX `idx_learned_rules_active` ON `learned_rules` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_learned_rules_type_scope_active` ON `learned_rules` (`rule_type`,`scope_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `learned_rules_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer NOT NULL,
	`rule_text` text NOT NULL,
	`confidence` real,
	`source_count` integer,
	`change_type` text NOT NULL,
	`change_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`rule_id`) REFERENCES `learned_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_learned_rules_history_rule_id` ON `learned_rules_history` (`rule_id`);--> statement-breakpoint
CREATE INDEX `idx_learned_rules_history_created` ON `learned_rules_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text,
	`message` text,
	`service` text,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_logs_timestamp` ON `logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_logs_level` ON `logs` (`level`);--> statement-breakpoint
CREATE INDEX `idx_logs_service` ON `logs` (`service`);--> statement-breakpoint
CREATE TABLE `meeting_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`participant_id` text NOT NULL,
	`participant_type` text DEFAULT 'email',
	`status` text DEFAULT 'pending',
	`responded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_meeting_participants_meeting_id` ON `meeting_participants` (`meeting_id`);--> statement-breakpoint
CREATE TABLE `meeting_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` integer NOT NULL,
	`reminder_time` text NOT NULL,
	`sent` integer DEFAULT false,
	`sent_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_meeting_reminders_reminder_time` ON `meeting_reminders` (`reminder_time`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`scheduled_time` text NOT NULL,
	`duration_minutes` integer DEFAULT 30,
	`timezone` text DEFAULT 'UTC',
	`participants` text DEFAULT '[]',
	`status` text DEFAULT 'scheduled',
	`created_via` text DEFAULT 'api',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_meetings_user_id` ON `meetings` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_meetings_scheduled_time` ON `meetings` (`scheduled_time`);--> statement-breakpoint
CREATE INDEX `idx_meetings_status` ON `meetings` (`status`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`context` text DEFAULT '',
	`timestamp` text NOT NULL,
	`importance` integer DEFAULT 5,
	`metadata` text DEFAULT '{}',
	`embedding` text,
	`related_message_id` text,
	`guild_id` text,
	`channel_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_memories_user_id` ON `memories` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_timestamp` ON `memories` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_memories_importance` ON `memories` (`importance`);--> statement-breakpoint
CREATE INDEX `idx_memories_guild_id` ON `memories` (`guild_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`value` text NOT NULL,
	`user_id` text NOT NULL,
	`message_type` text DEFAULT 'discord',
	`channel_id` text,
	`guild_id` text,
	`conversation_id` text,
	`role` text,
	`memory_id` integer,
	`related_message_id` text,
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_messages_user_id` ON `messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `model_usage_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_name` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text,
	`input_length` integer DEFAULT 0,
	`output_length` integer DEFAULT 0,
	`response_time_ms` integer DEFAULT 0,
	`capabilities_detected` integer DEFAULT 0,
	`capabilities_executed` integer DEFAULT 0,
	`capability_types` text DEFAULT '',
	`success` integer DEFAULT true,
	`error_type` text,
	`prompt_tokens` integer DEFAULT 0,
	`completion_tokens` integer DEFAULT 0,
	`total_tokens` integer DEFAULT 0,
	`estimated_cost` real DEFAULT 0,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_usage_user_time` ON `model_usage_stats` (`user_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_usage_model_time` ON `model_usage_stats` (`model_name`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_usage_timestamp` ON `model_usage_stats` (`timestamp`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` text,
	`scopes` text,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_user_provider` ON `oauth_tokens` (`user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_oauth_expires` ON `oauth_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `prompt_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt_id` integer NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`changed_by` text,
	`change_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'general',
	`is_active` integer DEFAULT true,
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_name_unique` ON `prompts` (`name`);--> statement-breakpoint
CREATE INDEX `idx_prompts_name_active` ON `prompts` (`name`,`is_active`);--> statement-breakpoint
CREATE INDEX `idx_prompts_category` ON `prompts` (`category`);--> statement-breakpoint
CREATE TABLE `queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'pending',
	`task_type` text NOT NULL,
	`priority` integer DEFAULT 0,
	`payload` text DEFAULT '{}',
	`result` text,
	`error_message` text,
	`retry_count` integer DEFAULT 0,
	`max_retries` integer DEFAULT 3,
	`assigned_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_queue_status` ON `queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_queue_created_at` ON `queue` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_queue_priority` ON `queue` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_queue_task_type` ON `queue` (`task_type`);--> statement-breakpoint
CREATE TABLE `todo_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending',
	`position` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`completed_at` text,
	FOREIGN KEY (`list_id`) REFERENCES `todo_lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_todo_items_list_id` ON `todo_items` (`list_id`);--> statement-breakpoint
CREATE INDEX `idx_todo_items_status` ON `todo_items` (`status`);--> statement-breakpoint
CREATE TABLE `todo_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`goal_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_todo_lists_user_id` ON `todo_lists` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_todo_lists_user_name` ON `todo_lists` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending',
	`priority` integer DEFAULT 0,
	`due_date` text,
	`completed_at` text,
	`data` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_todos_user_status` ON `todos` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`discord_id` text,
	`phone_number` text,
	`email` text,
	`display_name` text NOT NULL,
	`preferred_channel` text DEFAULT 'discord',
	`metadata` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_discord_id_unique` ON `user_identities` (`discord_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_phone_number_unique` ON `user_identities` (`phone_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_email_unique` ON `user_identities` (`email`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_discord_id` ON `user_identities` (`discord_id`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_phone_number` ON `user_identities` (`phone_number`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_email` ON `user_identities` (`email`);
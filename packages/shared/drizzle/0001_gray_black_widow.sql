CREATE TABLE `context_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`system_prompt` text,
	`context_sources_json` text,
	`message_chain_json` text,
	`full_response` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`trace_id`) REFERENCES `generation_traces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_trace_id` ON `context_snapshots` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_created_at` ON `context_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `experiment_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`name` text NOT NULL,
	`variant_type` text NOT NULL,
	`variant_config` text NOT NULL,
	`weight` integer DEFAULT 50,
	`impressions` integer DEFAULT 0,
	`positive_count` integer DEFAULT 0,
	`negative_count` integer DEFAULT 0,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_variants_experiment_id` ON `experiment_variants` (`experiment_id`);--> statement-breakpoint
CREATE INDEX `idx_variants_name` ON `experiment_variants` (`experiment_id`,`name`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hypothesis` text,
	`target_type` text NOT NULL,
	`target_ids` text DEFAULT '[]',
	`status` text DEFAULT 'draft',
	`traffic_percent` integer DEFAULT 100,
	`started_at` text,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_experiments_status` ON `experiments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_experiments_target_type` ON `experiments` (`target_type`);--> statement-breakpoint
CREATE TABLE `generation_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`discord_message_id` text,
	`user_id` text NOT NULL,
	`guild_id` text,
	`channel_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer,
	`model_used` text,
	`model_tier` text,
	`context_token_count` integer,
	`memories_retrieved_count` integer DEFAULT 0,
	`rules_applied_count` integer DEFAULT 0,
	`rules_applied_ids` text DEFAULT '[]',
	`response_length` integer,
	`response_tokens` integer,
	`estimated_cost` real,
	`experiment_id` text,
	`variant_id` text,
	`feedback_sentiment` text,
	`feedback_emoji` text,
	`feedback_at` text,
	`success` integer DEFAULT true,
	`error_type` text
);
--> statement-breakpoint
CREATE INDEX `idx_traces_message_id` ON `generation_traces` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_discord_msg` ON `generation_traces` (`discord_message_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_user_id` ON `generation_traces` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_guild_id` ON `generation_traces` (`guild_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_started_at` ON `generation_traces` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_traces_experiment` ON `generation_traces` (`experiment_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `idx_traces_feedback` ON `generation_traces` (`feedback_sentiment`);--> statement-breakpoint
CREATE INDEX `idx_traces_model` ON `generation_traces` (`model_used`);
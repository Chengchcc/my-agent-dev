-- 0012: Agent Context and Runs - DESTRUCTIVE CLEAN CUTOVER, old session/checkpoint state is intentionally discarded.
ALTER TABLE `member` DROP COLUMN `session_id`;--> statement-breakpoint
CREATE TABLE `agent_context_tree` (
	`tree_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL REFERENCES `conversation`(`conversation_id`) ON DELETE cascade,
	`agent_member_id` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_tree_member` ON `agent_context_tree` (`conversation_id`,`agent_member_id`);--> statement-breakpoint
CREATE TABLE `agent_context_entry` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL REFERENCES `agent_context_tree`(`tree_id`) ON DELETE cascade,
	`parent_id` text REFERENCES `agent_context_entry`(`entry_id`) ON DELETE restrict,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ledger_seq` integer,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_context_entry_tree` ON `agent_context_entry` (`tree_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_context_entry_leaf` ON `agent_context_entry` (`tree_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `agent_context_branch` (
	`branch_id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL REFERENCES `agent_context_tree`(`tree_id`) ON DELETE cascade,
	`leaf_entry_id` text,
	`ledger_cursor` integer NOT NULL DEFAULT 0,
	`backend_kind` text NOT NULL,
	`is_default` integer NOT NULL DEFAULT 0,
	`revision` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_branch_default` ON `agent_context_branch` (`tree_id`) WHERE `is_default` = 1;--> statement-breakpoint
CREATE INDEX `idx_context_branch_tree` ON `agent_context_branch` (`tree_id`);--> statement-breakpoint
CREATE TABLE `backend_session_binding` (
	`branch_id` text PRIMARY KEY NOT NULL REFERENCES `agent_context_branch`(`branch_id`) ON DELETE cascade,
	`backend_session_id` text,
	`backend_kind` text NOT NULL,
	`synced_entry_id` text,
	`synced_revision` integer,
	`state` text NOT NULL DEFAULT 'active',
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `agent_run` (
	`run_id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL REFERENCES `agent_context_branch`(`branch_id`) ON DELETE cascade,
	`conversation_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`model_ref` text NOT NULL,
	`status` text NOT NULL DEFAULT 'running',
	`idempotency_key` text NOT NULL,
	`terminal_result` text,
	`config_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`terminal_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_idempotency` ON `agent_run` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_active_branch` ON `agent_run` (`branch_id`) WHERE `status` IN ('running', 'waiting', 'commit_failed');--> statement-breakpoint
CREATE INDEX `idx_agent_run_branch` ON `agent_run` (`branch_id`);--> statement-breakpoint
CREATE TABLE `branch_input_queue` (
	`input_id` text PRIMARY KEY NOT NULL,
	`branch_id` text NOT NULL REFERENCES `agent_context_branch`(`branch_id`) ON DELETE cascade,
	`mode` text NOT NULL,
	`message` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`delivery_idempotency_key` text NOT NULL,
	`input_idempotency_key` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_input_idem` ON `branch_input_queue` (`branch_id`,`input_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_delivery_idem` ON `branch_input_queue` (`delivery_idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_queue_order` ON `branch_input_queue` (`branch_id`,`created_at`,`input_id`);--> statement-breakpoint
CREATE TABLE `pending_action` (
	`action_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL REFERENCES `agent_run`(`run_id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`response` text,
	`response_idempotency_key` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pending_action_response_idem` ON `pending_action` (`response_idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_pending_action_run` ON `pending_action` (`run_id`);

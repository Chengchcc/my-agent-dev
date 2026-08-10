-- 0015: branch_input_queue gets a monotonic queue sequence. Ordering by
-- created_at + random input_id was unstable for same-millisecond enqueues;
-- the real insertion order is now an explicit AUTOINCREMENT key.
CREATE TABLE `branch_input_queue_new` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`input_id` text NOT NULL,
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
INSERT INTO `branch_input_queue_new` (`input_id`, `branch_id`, `mode`, `message`, `status`, `delivery_idempotency_key`, `input_idempotency_key`, `run_id`, `created_at`, `delivered_at`)
	SELECT `input_id`, `branch_id`, `mode`, `message`, `status`, `delivery_idempotency_key`, `input_idempotency_key`, `run_id`, `created_at`, `delivered_at`
	FROM `branch_input_queue`
	ORDER BY `rowid`;--> statement-breakpoint
DROP TABLE `branch_input_queue`;--> statement-breakpoint
ALTER TABLE `branch_input_queue_new` RENAME TO `branch_input_queue`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_delivery_idem` ON `branch_input_queue` (`delivery_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_input_idem` ON `branch_input_queue` (`branch_id`,`input_idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_queue_order` ON `branch_input_queue` (`branch_id`,`seq`);

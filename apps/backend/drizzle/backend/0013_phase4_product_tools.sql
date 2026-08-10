-- 0013: Phase 4 - run product-tool manifest + durable product tool call idempotency
ALTER TABLE `agent_run` ADD `product_tools` text;--> statement-breakpoint
CREATE TABLE `product_tool_call` (
	`run_id` text NOT NULL REFERENCES `agent_run`(`run_id`) ON DELETE cascade,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL DEFAULT 'completed',
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`run_id`,`call_id`)
);--> statement-breakpoint
CREATE INDEX `idx_product_tool_call_run` ON `product_tool_call` (`run_id`);

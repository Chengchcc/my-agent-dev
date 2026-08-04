-- 0016: loop_item gains generator/evaluator Agent Run identities (runId,
-- replacing the old span/session ids that were never persisted).
ALTER TABLE `loop_item` ADD COLUMN `generator_run_id` text;
--> statement-breakpoint
ALTER TABLE `loop_item` ADD COLUMN `evaluator_run_id` text;

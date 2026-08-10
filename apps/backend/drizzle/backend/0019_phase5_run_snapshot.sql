-- 0019: Phase 5 Run config snapshot. The Run freezes systemPrompt + skillRoots
-- at creation; the queue row persists the request-time snapshot (model_ref,
-- config_revision, workspace, system_prompt, skill_roots) so a queued input
-- promotes into a Run with ITS OWN config, never the previous Run's.
ALTER TABLE `agent_run` ADD COLUMN `system_prompt` text;
--> statement-breakpoint
ALTER TABLE `agent_run` ADD COLUMN `skill_roots` text;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `model_ref` text;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `config_revision` integer;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `workspace_root` text;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `workspace_access` text;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `system_prompt` text;
--> statement-breakpoint
ALTER TABLE `branch_input_queue` ADD COLUMN `skill_roots` text;

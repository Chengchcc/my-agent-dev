-- 0029: permission_mode freeze (ADR 0020 decision 7). The agent's
-- permission_mode (ask/auto/deny) is frozen at enqueue like systemPrompt /
-- skillRoots, so the claude adapter can map it to --permission-mode at
-- dispatch. Both the queue row and the run row carry it.
ALTER TABLE `branch_input_queue` ADD `permission_mode` text;--> statement-breakpoint
ALTER TABLE `agent_run` ADD `permission_mode` text;

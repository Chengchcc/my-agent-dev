-- 0017: Agent Run carries its own workspace snapshot. Workspace is an
-- execution fact of the Run (Loop Generator/Evaluator bind the cloned repo,
-- not the loop-agent workspace), so dispatch must not re-derive it from
-- conversation ids or agent records.
ALTER TABLE `agent_run` ADD COLUMN `workspace_root` text;
--> statement-breakpoint
ALTER TABLE `agent_run` ADD COLUMN `workspace_access` text;

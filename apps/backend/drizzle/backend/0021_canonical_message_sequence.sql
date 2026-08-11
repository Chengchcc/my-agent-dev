-- 0021: ADR 0017 canonical message contract. A completed Run now commits
-- its full canonical message sequence (assistant(tool_use) / tool(tool_result)
-- / assistant(text)) as multiple conversation_ledger rows. The terminal-commit
-- identity moves from a single unique agent_run_id to unique
-- (agent_run_id, message_index).
DROP INDEX `idx_ledger_agent_run`;--> statement-breakpoint
ALTER TABLE `conversation_ledger` ADD COLUMN `message_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `conversation_ledger` SET `message_index` = 0 WHERE `agent_run_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ledger_agent_run_message` ON `conversation_ledger` (`agent_run_id`,`message_index`) WHERE agent_run_id IS NOT NULL;

-- 0014: Phase 4 terminal-commit identity - the final assistant Message is
-- uniquely owned by its Agent Run so concurrent commit replays can never
-- write it twice.
ALTER TABLE `conversation_ledger` ADD `agent_run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ledger_agent_run` ON `conversation_ledger` (`agent_run_id`) WHERE `agent_run_id` IS NOT NULL;

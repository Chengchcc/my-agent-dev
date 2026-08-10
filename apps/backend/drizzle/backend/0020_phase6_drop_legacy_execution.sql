-- 0020: Phase 6 clean cutover. Legacy execution audit is deleted:
--   span / attempt / control_plane_event / span_origin are dropped (their
--   rows are discarded, not converted) — Agent Run is the only Product
--   execution identity (agent_run + product_tool_call hold the facts).
-- conversation_ledger drops the obsolete span_id column and idx_ledger_run;
-- agent_run_id stays the terminal-commit identity (idx_ledger_agent_run).
DROP TABLE `attempt`;--> statement-breakpoint
DROP TABLE `control_plane_event`;--> statement-breakpoint
DROP TABLE `span_origin`;--> statement-breakpoint
DROP TABLE `span`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_ledger` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_member_id` text NOT NULL,
	`addressed_to` text DEFAULT '[]' NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`ts` integer NOT NULL,
	`agent_run_id` text,
	`undone` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`conversation_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_conversation_ledger`("seq", "conversation_id", "sender_member_id", "addressed_to", "kind", "content", "ts", "agent_run_id", "undone") SELECT "seq", "conversation_id", "sender_member_id", "addressed_to", "kind", "content", "ts", "agent_run_id", "undone" FROM `conversation_ledger`;--> statement-breakpoint
DROP TABLE `conversation_ledger`;--> statement-breakpoint
ALTER TABLE `__new_conversation_ledger` RENAME TO `conversation_ledger`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_ledger_conv` ON `conversation_ledger` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ledger_agent_run` ON `conversation_ledger` (`agent_run_id`) WHERE agent_run_id IS NOT NULL;

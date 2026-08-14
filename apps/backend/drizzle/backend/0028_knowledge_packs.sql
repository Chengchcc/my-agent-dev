-- 0028: Knowledge packs (ADR 0022). knowledge_pack mirrors skill_pack's
-- install model (builtin/git/zip). Per-agent switches live in agent.yml
-- (file-first) - no assignment table.
CREATE TABLE `knowledge_pack` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text,
	`version_ref` text,
	`installed_ref` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_knowledge_pack_status` ON `knowledge_pack` (`status`);

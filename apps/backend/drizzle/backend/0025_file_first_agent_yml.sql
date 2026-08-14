-- 0025: file-first agent.yml (ADR 0003 decision 1).
-- Content columns fold into a single `config` JSON cache (the parsed
-- agent.yml); only id / workspace_path / archived_at / timestamps stay
-- relational. Upgrade policy: delete .backend-data and re-boot - the
-- legacy rows are never converted in place.
ALTER TABLE `agents` ADD COLUMN `config` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `name`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `template`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `model_provider`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `model_name`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `backend_kind`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `reasoning_effort`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `permission_mode`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `max_steps`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `lark_enabled`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `lark_app_id`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `lark_profile_ref`;
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `lark_bot_display_name`;

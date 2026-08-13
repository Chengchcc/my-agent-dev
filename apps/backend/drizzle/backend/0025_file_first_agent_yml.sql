-- 0025: file-first agent.yml (ADR 0003 decision 1).
-- Content columns fold into a single `config` JSON cache (the parsed
-- agent.yml); only id / workspace_path / archived_at / timestamps stay
-- relational. Existing rows are converted in place before the drops.
ALTER TABLE `agents` ADD COLUMN `config` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE `agents` SET `config` = json_object(
  'schema_version', '1',
  'enabled', 1,
  'id', `id`,
  'name', `name`,
  'title', `name`,
  'description', '',
  'runtime_config', json_object(
    'runtime', `backend_kind`,
    'model_id', `model_provider` || '/' || `model_name`,
    'reasoning_effort', coalesce(`reasoning_effort`, ''),
    'permission_mode', `permission_mode`,
    'max_steps', coalesce(`max_steps`, 0)
  ),
  'lark', json_object(
    'enabled', `lark_enabled`,
    'app_id', coalesce(`lark_app_id`, ''),
    'bot_display_name', coalesce(`lark_bot_display_name`, ''),
    'profile_ref', coalesce(`lark_profile_ref`, '')
  )
);
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

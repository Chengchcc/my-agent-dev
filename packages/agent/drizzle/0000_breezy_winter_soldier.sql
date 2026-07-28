CREATE TABLE `checkpoint_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`span_id` text,
	`event` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_checkpoint_events_span` ON `checkpoint_events` (`session_id`,`span_id`,`id`);--> statement-breakpoint
CREATE TABLE `checkpoint_interrupts` (
	`session_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkpoint_messages` (
	`session_id` text PRIMARY KEY NOT NULL,
	`messages` text NOT NULL,
	`updated_at` integer NOT NULL
);

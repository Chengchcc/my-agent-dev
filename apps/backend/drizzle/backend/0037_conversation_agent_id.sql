ALTER TABLE "conversation" ADD "agent_id" text;--> statement-breakpoint
UPDATE "conversation" SET "agent_id" = (SELECT "m"."agent_id" FROM "member" "m" WHERE "m"."conversation_id" = "conversation"."conversation_id" AND "m"."kind" = 'agent' LIMIT 1);--> statement-breakpoint
ALTER TABLE "agent_run" RENAME COLUMN "agent_member_id" TO "agent_id";--> statement-breakpoint
UPDATE "agent_run" SET "agent_id" = COALESCE((SELECT "m"."agent_id" FROM "member" "m" WHERE "m"."member_id" = "agent_run"."agent_id"), "agent_id");--> statement-breakpoint
DROP INDEX "idx_context_tree_member";--> statement-breakpoint
ALTER TABLE "agent_context_tree" DROP COLUMN "agent_member_id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_context_tree_conversation" ON "agent_context_tree" ("conversation_id");--> statement-breakpoint
DROP TABLE "member";

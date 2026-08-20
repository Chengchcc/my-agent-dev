-- taskClass + defer on loop items (workflow-first loop).
ALTER TABLE loop_item ADD COLUMN task_class TEXT;
--> statement-breakpoint
ALTER TABLE loop_item ADD COLUMN defer TEXT;

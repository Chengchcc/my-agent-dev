ALTER TABLE conversation ADD COLUMN project_id text REFERENCES project(project_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE project DROP COLUMN auto_orchestrate;

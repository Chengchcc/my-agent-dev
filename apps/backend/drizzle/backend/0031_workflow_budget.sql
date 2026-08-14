ALTER TABLE agent_run ADD COLUMN workflow_budget_tokens integer;
--> statement-breakpoint
ALTER TABLE branch_input_queue ADD COLUMN workflow_budget_tokens integer;

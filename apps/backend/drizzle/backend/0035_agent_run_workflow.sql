-- Oma workflow-mode input: the child executes the script directly instead
-- of an interactive loop (Loop items, workflow-first execution model).
ALTER TABLE agent_run ADD COLUMN workflow TEXT;

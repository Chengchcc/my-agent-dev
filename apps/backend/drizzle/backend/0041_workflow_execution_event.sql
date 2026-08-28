CREATE TABLE IF NOT EXISTS workflow_execution_event (
  seq integer PRIMARY KEY AUTOINCREMENT,
  execution_id text NOT NULL REFERENCES workflow_execution(execution_id) ON DELETE CASCADE,
  event text NOT NULL,
  data text NOT NULL,
  ts integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_execution_event_exec ON workflow_execution_event(execution_id, seq);

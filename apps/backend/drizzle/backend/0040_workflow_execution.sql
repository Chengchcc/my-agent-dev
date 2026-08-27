CREATE TABLE IF NOT EXISTS workflow_execution (
  execution_id text PRIMARY KEY NOT NULL,
  workflow_id text NOT NULL,
  definition text NOT NULL,
  input text NOT NULL,
  store text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running',
  exit text,
  error text,
  created_at integer NOT NULL,
  terminal_at integer
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_node_run (
  seq integer PRIMARY KEY AUTOINCREMENT,
  execution_id text NOT NULL REFERENCES workflow_execution(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  "order" integer NOT NULL,
  output text,
  routed_to text,
  error text,
  created_at integer NOT NULL,
  terminal_at integer
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_node_run_exec ON workflow_node_run(execution_id, seq);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_pending_human (
  execution_id text NOT NULL REFERENCES workflow_execution(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  question text,
  form text,
  status text NOT NULL DEFAULT 'pending',
  created_at integer NOT NULL,
  terminal_at integer,
  PRIMARY KEY (execution_id, node_id)
);

-- Run telemetry: durable normalized backend events (tool calls, status,
-- workflow steps). text_delta/thinking_delta are NOT persisted (transient,
-- large); usage lives on agent_run.terminal_result.
CREATE TABLE IF NOT EXISTS agent_run_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_run(run_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_run_event_run ON agent_run_event(run_id, seq);

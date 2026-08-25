CREATE INDEX IF NOT EXISTS idx_agent_run_event_run ON agent_run_event(run_id, seq);--> statement-breakpoint
UPDATE agent_run SET model_ref = json_set(model_ref, '$.backendKind', 'oma') WHERE json_extract(model_ref, '$.backendKind') = 'coding_agent';

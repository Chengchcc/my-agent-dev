-- Rename legacy runtime kind coding_agent -> oma in persisted data
-- (rename commit 445d9388 missed stored rows; loops/exec dispatch broke
-- resolving the old kind). Idempotent: no-op when no legacy rows remain.

UPDATE agents
   SET config = json_set(config, '$.runtime_config.runtime', 'oma')
 WHERE json_extract(config, '$.runtime_config.runtime') = 'coding_agent';
-- statement-breakpoint
UPDATE agent_run
   SET model_ref = json_set(model_ref, '$.backendKind', 'oma')
 WHERE json_extract(model_ref, '$.backendKind') = 'coding_agent';

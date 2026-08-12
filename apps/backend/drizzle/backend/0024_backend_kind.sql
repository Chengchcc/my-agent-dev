-- 0024: per-agent backend kind + per-branch CLI session ref (ADR 0002).
-- agents.backend_kind defaults to the existing single-backend behavior;
-- agent_context_branch.cli_session_ref stays null until the first
-- CLI-backed run (claude session_id / pi-omp session file path).
ALTER TABLE `agents` ADD COLUMN `backend_kind` text NOT NULL DEFAULT 'coding_agent';
--> statement-breakpoint
ALTER TABLE `agent_context_branch` ADD COLUMN `cli_session_ref` text;

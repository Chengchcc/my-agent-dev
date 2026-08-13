-- 0027: MCP unified catalog (ADR 0022). The per-agent mcp_server table
-- is RENAMED (not dropped): the bootstrap backfill promotes each agent's
-- SUBSET into agent.yml switches + writes the deployment catalog file
-- (<dataDir>/mcp-servers.json, file-first like models.yml), then drops
-- mcp_server_legacy. No MCP tables remain in the DB.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `mcp_server` RENAME TO `mcp_server_legacy`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

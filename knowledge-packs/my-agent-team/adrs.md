# Key ADRs

- ADR 0020: agent.yml is the portable agent config single source; DB keeps only
  the anchor row plus a materialized cache. Identity files SOUL.md and USER.md
  are frozen into each run snapshot.
- ADR 0022: MCP servers and knowledge packs are global pools with per-agent
  switches in agent.yml. The workspace bridge merges enabled servers into
  .mcp.json and symlinks assigned knowledge packs into the workspace.
- ADR 0023: projects attach to agents and materialize as git worktrees under the
  agent workspace. The same MCP + product-tools bridge is written into worktree
  roots.
- Phase 5: run-centric rewrite. The product adapter spawns coding-agent --mode rpc
  per Product Run; the backend persists frozen run snapshots and per-input config
  snapshots; idle branches with pending inputs recover at boot.
- Phase 6: clean cutover. Legacy execution schema (span/attempt/control_plane_event)
  dropped; Agent Run is the only product execution identity.

## Run verdict

The model's final PASS/FAIL text is not trusted. Backend derives verdict from
tool_result.is_error flags in the committed run. UI keeps showing tool traces;
acceptance reads tool records, not assistant text.

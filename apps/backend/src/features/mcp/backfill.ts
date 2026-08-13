import type { Database } from "bun:sqlite";
import { mergeMcpCatalog } from "./adapter-file.js";
import type { AgentMcpAssignment } from "./domain.js";

interface LegacyRow {
  agent_id: string;
  server_id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** One-time backfill (ADR 0022): after 0027 renamed the old per-agent
 *  mcp_server table, each agent's SUBSET becomes agent.yml switches and
 *  the deduped server definitions become the deployment catalog file
 *  (<dataDir>/mcp-servers.json, file-first like models.yml). Idempotent:
 *  the legacy table exists only until the first boot, then it is dropped. */
export async function backfillLegacyMcpAssignments(
  db: Database,
  dataDir: string,
  deps: {
    listAgents: () => Promise<Array<{ id: string }>>;
    getAgentMcpServers: (agentId: string) => Promise<AgentMcpAssignment[]>;
    setAgentMcpServers: (agentId: string, entries: AgentMcpAssignment[]) => Promise<void>;
  },
): Promise<void> {
  const legacy = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_server_legacy'`)
    .all() as Array<{ name: string }>;
  if (legacy.length === 0) return;

  const legacyRows = db
    .query(
      `SELECT agent_id, server_id, name, transport, command, args, env, url, enabled, created_at, updated_at FROM mcp_server_legacy`,
    )
    .all() as unknown as LegacyRow[];

  const parseJson = <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  // Dedupe server definitions: (name, transport, url|command) with the
  // MIN(server_id) row surviving (deterministic, mirrors the old SQL).
  const key = (r: LegacyRow) => `${r.name}\u0000${r.transport}\u0000${r.url ?? r.command ?? ""}`;
  const byKey = new Map<string, LegacyRow>();
  for (const row of legacyRows) {
    const k = key(row);
    const existing = byKey.get(k);
    if (!existing || row.server_id < existing.server_id) byKey.set(k, row);
  }
  mergeMcpCatalog(
    dataDir,
    [...byKey.values()].map((r) => ({
      serverId: r.server_id,
      name: r.name,
      transport: r.transport as "stdio" | "sse",
      command: r.command,
      args: parseJson(r.args, [] as string[]),
      env: parseJson(r.env, {} as Record<string, string>),
      url: r.url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  );

  // Per-agent subsets -> agent.yml switches (legacy rows win over absent).
  const byAgent = new Map<string, Map<string, boolean>>();
  for (const row of legacyRows) {
    const switches = byAgent.get(row.agent_id) ?? new Map();
    switches.set(row.server_id, (switches.get(row.server_id) ?? false) || row.enabled === 1);
    byAgent.set(row.agent_id, switches);
  }
  for (const agent of await deps.listAgents()) {
    const legacySwitches = byAgent.get(agent.id);
    if (!legacySwitches || legacySwitches.size === 0) continue;
    const existing = await deps.getAgentMcpServers(agent.id);
    const merged = new Map(existing.map((e) => [e.serverId, e.enabled]));
    for (const [serverId, enabled] of legacySwitches) {
      if (!merged.has(serverId)) merged.set(serverId, enabled);
    }
    await deps.setAgentMcpServers(
      agent.id,
      [...merged].map(([serverId, enabled]) => ({ serverId, enabled })),
    );
  }

  db.run(`DROP TABLE mcp_server_legacy`);
}

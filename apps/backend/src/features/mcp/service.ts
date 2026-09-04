import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import { ulid } from "../../infra/ids.js";
import type {
  AgentMcpAssignment,
  CreateMcpServerInput,
  McpServerRow,
  UpdateMcpServerInput,
} from "./domain.js";
import type { McpServerPort } from "./ports.js";
import type { McpRuntimeStatusStore } from "./runtime-status.js";
export class McpServerNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("MCP server", id);
  }
}

export class McpValidationError extends ValidationError {}

/** MCP unified catalog (ADR 0022): a global server pool. Per-agent
 *  switches live in agent.yml (file-first) - the service reads/writes
 *  them through the `agentMcpServers` callbacks wired to the agent
 *  service. */
export interface McpService {
  listCatalog(): McpServerRow[];
  create(input: CreateMcpServerInput): Promise<McpServerRow>;
  update(serverId: string, input: UpdateMcpServerInput): Promise<McpServerRow>;
  delete(serverId: string): Promise<void>;
  listAssignments(agentId: string): Promise<AgentMcpAssignment[]>;
  setAgentServers(agentId: string, entries: AgentMcpAssignment[]): Promise<void>;
  /** Assigned AND enabled servers (the workspace bridge's input). */
  listForAgent(agentId: string): Promise<McpServerRow[]>;
  /** Raw (unmasked) single server — the edit form's source of truth. */
  getServer(serverId: string): McpServerRow;
  /** Explicit probe: reconnects and reports manager status + tool count. */
  testConnection(serverId: string): Promise<{ status: string; toolsCount: number }>;
}

function maskSecrets(record: Record<string, string> | null): Record<string, string> | null {
  if (!record) return record;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    masked[k] = v.length > 4 ? `****${v.slice(-4)}` : "****";
  }
  return masked;
}

function maskRow(row: McpServerRow): McpServerRow {
  return { ...row, env: maskSecrets(row.env), headers: maskSecrets(row.headers) };
}

export function createMcpService(deps: {
  port: McpServerPort;
  mcpClientManager: McpClientManager;
  /** Latest runtime mount results; absent keeps the manager probe only. */
  runtimeStatus?: McpRuntimeStatusStore;
  agentExists: (id: string) => Promise<boolean>;
  getAgentMcpServers: (agentId: string) => Promise<AgentMcpAssignment[]>;
  setAgentMcpServers: (agentId: string, entries: AgentMcpAssignment[]) => Promise<void>;
  idGen?: () => string;
}): McpService {
  const idGen = deps.idGen ?? ulid;

  function requireServer(serverId: string): McpServerRow {
    const r = deps.port.getById(serverId);
    if (!r) throw new McpServerNotFoundError(serverId);
    return r;
  }

  function withStatus(row: McpServerRow): McpServerRow {
    const runtime = deps.runtimeStatus?.latest(row.name);
    return {
      ...row,
      status: deps.mcpClientManager.getStatus(row.serverId),
      toolsCount: deps.mcpClientManager.getToolCount(row.serverId),
      ...(runtime
        ? {
            runtimeStatus: runtime.ok ? ("mounted" as const) : ("failed" as const),
            runtimeToolsCount: runtime.toolsCount,
            ...(runtime.error ? { runtimeError: runtime.error } : {}),
            runtimeRunId: runtime.runId,
            runtimeCheckedAt: runtime.at,
          }
        : {}),
    };
  }

  return {
    listCatalog(): McpServerRow[] {
      return deps.port.list().map(maskRow).map(withStatus);
    },

    async create(input: CreateMcpServerInput): Promise<McpServerRow> {
      const now = Date.now();
      const serverId = idGen();
      const row = deps.port.create({
        serverId,
        name: input.name,
        transport: input.transport,
        command: input.command ?? null,
        args: input.args ? JSON.stringify(input.args) : "[]",
        env: input.env ? JSON.stringify(input.env) : "{}",
        headers: input.headers ? JSON.stringify(input.headers) : "{}",
        url: input.url ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return maskRow(withStatus(row));
    },

    async update(serverId: string, input: UpdateMcpServerInput): Promise<McpServerRow> {
      requireServer(serverId);
      const patch: {
        name?: string;
        command?: string | null;
        args?: string | null;
        env?: string | null;
        headers?: string | null;
        url?: string | null;
      } = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.command !== undefined) patch.command = input.command;
      if (input.args !== undefined) patch.args = JSON.stringify(input.args);
      if (input.env !== undefined) patch.env = JSON.stringify(input.env);
      if (input.headers !== undefined) patch.headers = JSON.stringify(input.headers);
      if (input.url !== undefined) patch.url = input.url;
      const row = deps.port.update(serverId, { ...patch, updatedAt: Date.now() });
      if (!row) throw new McpServerNotFoundError(serverId);
      return maskRow(withStatus(row));
    },

    async delete(serverId: string): Promise<void> {
      requireServer(serverId);
      deps.mcpClientManager.disconnect(serverId);
      deps.port.delete(serverId);
    },

    async listAssignments(agentId: string): Promise<AgentMcpAssignment[]> {
      return deps.getAgentMcpServers(agentId);
    },

    async setAgentServers(agentId: string, entries: AgentMcpAssignment[]): Promise<void> {
      if (!(await deps.agentExists(agentId))) {
        throw new McpValidationError(`Agent not found: ${agentId}`);
      }
      for (const e of entries) requireServer(e.serverId);
      await deps.setAgentMcpServers(agentId, entries);
      // Connect enabled servers for status display; disconnect the rest.
      for (const e of entries) {
        const row = requireServer(e.serverId);
        if (e.enabled) {
          void deps.mcpClientManager
            .connect({
              serverId: row.serverId,
              agentId: "*",
              name: row.name,
              transport: row.transport,
              ...(row.command ? { command: row.command } : {}),
              ...(row.args ? { args: row.args } : {}),
              ...(row.env ? { env: row.env } : {}),
              ...(row.url ? { url: row.url } : {}),
              enabled: true,
            })
            .catch(() => {});
        } else {
          deps.mcpClientManager.disconnect(e.serverId);
        }
      }
    },
    async listForAgent(agentId: string): Promise<McpServerRow[]> {
      const assigned = (await deps.getAgentMcpServers(agentId))
        .filter((a) => a.enabled)
        .map((a) => a.serverId);
      const byId = new Map(deps.port.list().map((r) => [r.serverId, r]));
      return assigned.map((id) => byId.get(id)).filter((r): r is McpServerRow => r !== undefined);
    },

    getServer(serverId: string): McpServerRow {
      return requireServer(serverId);
    },

    async testConnection(serverId: string): Promise<{ status: string; toolsCount: number }> {
      const row = requireServer(serverId);
      const config: Parameters<McpClientManager["connect"]>[0] = {
        serverId: row.serverId,
        agentId: "*",
        name: row.name,
        transport: row.transport,
        enabled: true,
      };
      if (row.command) config.command = row.command;
      if (row.args) config.args = row.args;
      if (row.env) config.env = row.env;
      if (row.url) config.url = row.url;
      try {
        await deps.mcpClientManager.connect(config);
      } catch {
        /* missing command/url: manager recorded a failed entry */
      }
      return {
        status: deps.mcpClientManager.getStatus(serverId) ?? "failed",
        toolsCount: deps.mcpClientManager.getToolCount(serverId),
      };
    },
  };
}

import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import { ulid } from "../../infra/ids.js";
import type {
  AgentMcpAssignment,
  CreateMcpServerInput,
  McpServerRow,
  UpdateMcpServerInput,
} from "./domain.js";
import type { McpServerPort } from "./ports.js";

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
}

function maskEnv(row: McpServerRow): McpServerRow {
  if (!row.env) return row;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.env)) {
    masked[k] = v.length > 4 ? `****${v.slice(-4)}` : "****";
  }
  return { ...row, env: masked };
}

export function createMcpService(deps: {
  port: McpServerPort;
  mcpClientManager: McpClientManager;
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

  const withStatus = (row: McpServerRow): McpServerRow => ({
    ...row,
    status: deps.mcpClientManager.getStatus(row.serverId),
    toolsCount: deps.mcpClientManager.getToolCount(row.serverId),
  });

  return {
    listCatalog(): McpServerRow[] {
      return deps.port.list().map(maskEnv).map(withStatus);
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
        url: input.url ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return maskEnv(withStatus(row));
    },

    async update(serverId: string, input: UpdateMcpServerInput): Promise<McpServerRow> {
      requireServer(serverId);
      const row = deps.port.update(serverId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.args !== undefined ? { args: JSON.stringify(input.args) } : {}),
        ...(input.env !== undefined ? { env: JSON.stringify(input.env) } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        updatedAt: Date.now(),
      });
      if (!row) throw new McpServerNotFoundError(serverId);
      return maskEnv(withStatus(row));
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
      return assigned
        .map((id) => byId.get(id))
        .filter((r): r is McpServerRow => r !== undefined)
        .map(maskEnv);
    },
  };
}

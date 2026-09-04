/** MCP server catalog (ADR 0022): a global server pool + per-agent
 *  assignment switch. The workspace bridge writes assigned+enabled servers
 *  into each agent's .mcp.json. */
export interface McpServerRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  /** SSE request headers (e.g. Authorization). Never exposed raw via HTTP. */
  headers: Record<string, string> | null;
  url: string | null;
  createdAt: number;
  updatedAt: number;
  status?: "pending" | "connected" | "failed";
  toolsCount?: number;
  /** Latest REAL runtime mount observation (from the oma child's
   *  mcp_mount_result event). Absent until a Run has mounted this server. */
  runtimeStatus?: "mounted" | "failed";
  runtimeToolsCount?: number;
  runtimeError?: string;
  runtimeRunId?: string;
  runtimeCheckedAt?: number;
}

/** One agent's assignment for a catalog server (the per-agent switch). */
export interface AgentMcpAssignment {
  serverId: string;
  enabled: boolean;
}

export interface CreateMcpServerInput {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
}

export interface UpdateMcpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
}

/** Last REAL runtime mount result per MCP server name.
 *
 *  The manager-side probe (testConnection) proves the backend can reach the
 *  server, not that an agent Run's child mounted it. Runtime mount results
 *  flow back as `backend.oma.mcp_mount_result` extension events; this store
 *  keeps only the latest one per catalog name. In-memory by design: it is
 *  observation telemetry, not durable product state. */
export interface McpRuntimeMountResult {
  readonly serverName: string;
  readonly ok: boolean;
  readonly toolsCount: number;
  readonly error?: string;
  readonly runId: string;
  readonly at: number;
}

export interface McpRuntimeStatusStore {
  record(result: McpRuntimeMountResult): void;
  latest(serverName: string): McpRuntimeMountResult | undefined;
}

export function createMcpRuntimeStatusStore(): McpRuntimeStatusStore {
  const latestByName = new Map<string, McpRuntimeMountResult>();
  return {
    record(result) {
      latestByName.set(result.serverName, result);
    },
    latest(serverName) {
      return latestByName.get(serverName);
    },
  };
}

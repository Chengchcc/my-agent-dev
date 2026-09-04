import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mcpKeys } from "./query-keys";

export interface McpCatalogRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  url: string | null;
  status?: string;
  toolsCount?: number;
  runtimeStatus?: "mounted" | "failed";
  runtimeToolsCount?: number;
  runtimeError?: string;
  runtimeRunId?: string;
  runtimeCheckedAt?: number;
}

export function mcpCatalogQuery() {
  return queryOptions({
    queryKey: mcpKeys.all,
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: McpCatalogRow[] }>,
  });
}

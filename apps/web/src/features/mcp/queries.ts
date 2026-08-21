import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mcpKeys } from "./query-keys";

export interface McpCatalogRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  url: string | null;
  status?: string;
  toolsCount?: number;
}

export function mcpCatalogQuery() {
  return queryOptions({
    queryKey: mcpKeys.all,
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: McpCatalogRow[] }>,
  });
}

import type { McpServerRow } from "./domain.js";

export interface CreateMcpServerRecord {
  serverId: string;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateMcpServerRecord {
  name?: string;
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  updatedAt: number;
}

/** Global catalog CRUD (ADR 0022). Per-agent switches live in agent.yml,
 *  not here. */
export interface McpServerPort {
  create(input: CreateMcpServerRecord): McpServerRow;
  list(): McpServerRow[];
  getById(serverId: string): McpServerRow | null;
  update(serverId: string, patch: UpdateMcpServerRecord): McpServerRow | null;
  delete(serverId: string): boolean;
}

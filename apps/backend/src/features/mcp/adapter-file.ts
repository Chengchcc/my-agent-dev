import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerRow } from "./domain.js";
import type { CreateMcpServerRecord, McpServerPort, UpdateMcpServerRecord } from "./ports.js";

/** File-backed catalog (ADR 0022): server definitions live in
 *  <dataDir>/mcp-servers.json — deployment-level config, human-editable,
 *  like models.yml. No DB table. Writes are synchronous whole-file
 *  rewrites (the catalog is tiny; ponytail: no locking beyond the
 *  process). */

export interface FileEntry {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  createdAt: number;
  updatedAt: number;
}

export function mcpCatalogPath(dataDir: string): string {
  return join(dataDir, "mcp-servers.json");
}

export function readMcpCatalog(dataDir: string): FileEntry[] {
  const path = mcpCatalogPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { servers?: FileEntry[] };
    return parsed.servers ?? [];
  } catch {
    return [];
  }
}

function writeMcpCatalog(dataDir: string, servers: FileEntry[]): void {
  writeFileSync(mcpCatalogPath(dataDir), `${JSON.stringify({ servers }, null, 2)}\n`);
}

/** Backfill seam: merge entries into the catalog file (used by the 0027
 *  promotion). */
export function mergeMcpCatalog(dataDir: string, entries: FileEntry[]): void {
  const byServerId = new Map(readMcpCatalog(dataDir).map((e) => [e.serverId, e]));
  for (const entry of entries) {
    if (!byServerId.has(entry.serverId)) byServerId.set(entry.serverId, entry);
  }
  writeMcpCatalog(dataDir, [...byServerId.values()]);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    return JSON.parse(raw ?? "") as T;
  } catch {
    return fallback;
  }
}

export function fileMcpServerAdapter(dataDir: string): McpServerPort {
  const rows = (): McpServerRow[] =>
    readMcpCatalog(dataDir).map((e) => ({
      serverId: e.serverId,
      name: e.name,
      transport: e.transport,
      command: e.command,
      args: e.args,
      env: e.env,
      url: e.url,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

  return {
    create(input: CreateMcpServerRecord): McpServerRow {
      const servers = readMcpCatalog(dataDir);
      servers.push({
        serverId: input.serverId,
        name: input.name,
        transport: input.transport as "stdio" | "sse",
        command: input.command,
        args: parseJson(input.args, [] as string[]),
        env: parseJson(input.env, {} as Record<string, string>),
        url: input.url,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      writeMcpCatalog(dataDir, servers);
      return rows().find((r) => r.serverId === input.serverId)!;
    },

    list(): McpServerRow[] {
      return rows();
    },

    getById(serverId: string): McpServerRow | null {
      return rows().find((r) => r.serverId === serverId) ?? null;
    },

    update(serverId: string, patch: UpdateMcpServerRecord): McpServerRow | null {
      const servers = readMcpCatalog(dataDir);
      const idx = servers.findIndex((e) => e.serverId === serverId);
      if (idx < 0) return null;
      const entry = servers[idx]!;
      servers[idx] = {
        ...entry,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.command !== undefined ? { command: patch.command } : {}),
        ...(patch.args !== undefined ? { args: parseJson(patch.args, [] as string[]) } : {}),
        ...(patch.env !== undefined
          ? { env: parseJson(patch.env, {} as Record<string, string>) }
          : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        updatedAt: patch.updatedAt,
      };
      writeMcpCatalog(dataDir, servers);
      return rows().find((r) => r.serverId === serverId) ?? null;
    },

    delete(serverId: string): boolean {
      const servers = readMcpCatalog(dataDir);
      const next = servers.filter((e) => e.serverId !== serverId);
      if (next.length === servers.length) return false;
      writeMcpCatalog(dataDir, next);
      return true;
    },
  };
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig } from "../config.js";

/** Resolve the knowledge recall MCP server entry (ADR 0022). The agent's
 *  MCP client spawns it via .mcp.json with an ABSOLUTE path (the client's
 *  cwd is the workspace, not the backend).
 *
 *  - `KNOWLEDGE_MCP_SERVER_BIN` configured (exotic deployment): run that.
 *  - Monorepo dev: the backend runs from SOURCE (bun executes .ts) — use
 *    src/features/knowledge/mcp-server.ts.
 *  - Built backend (tsc → dist): the CURRENT file is .js, so the sibling
 *    dist/features/knowledge/mcp-server.js is the artifact. */
export function resolveKnowledgeMcpServerEntry(config: BackendConfig): string {
  if (config.knowledgeMcpServerBin) return config.knowledgeMcpServerBin;
  const isDev = import.meta.filename.endsWith(".ts");
  const base = resolve(import.meta.dir, "../features/knowledge/mcp-server");
  const entry = isDev ? `${base}.ts` : `${base}.js`;
  if (!existsSync(entry)) {
    throw new Error(`Knowledge MCP server entry not found: ${entry}`);
  }
  return entry;
}

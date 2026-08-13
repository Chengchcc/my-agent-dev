import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** BackendKind → project config dir (ADR 0003 decision 2: the four
 *  config dirs each coding agent reads from its cwd). */
export const KIND_DIR: Record<string, string> = {
  coding_agent: ".agent",
  pi: ".pi",
  omp: ".omp",
  claude_code: ".claude",
};

export interface SkillLink {
  id: string;
  /** Absolute source directory (the skill pack install dir). */
  source: string;
}

export interface McpServerEntry {
  name: string;
  transport: "stdio" | "sse";
  url?: string | null;
  command?: string | null;
}

/** Reconcile the `<kind>/skills/` symlinks: create missing links to the
 *  assigned packs, remove stale ones. A non-symlink entry at a pack slot
 *  (user's own dir) is never clobbered. Idempotent. */
export function reconcileSkillLinks(
  workspacePath: string,
  kind: string,
  packs: readonly SkillLink[],
): void {
  const dir = join(workspacePath, KIND_DIR[kind] ?? `.${kind}`, "skills");
  mkdirSync(dir, { recursive: true });
  const want = new Set(packs.map((p) => p.id));
  for (const entry of readdirSync(dir)) {
    if (want.has(entry)) continue;
    try {
      unlinkSync(join(dir, entry)); // stale symlink (or file) — drop
    } catch {
      /* non-empty dir or race: leave */
    }
  }
  for (const pack of packs) {
    const link = join(dir, pack.id);
    try {
      if (lstatSync(link).isSymbolicLink()) {
        if (readlinkSync(link) === pack.source) continue;
        unlinkSync(link);
      } else if (existsSync(link)) {
        continue; // user's own directory at this slot — never clobber
      }
    } catch {
      /* link missing */
    }
    try {
      symlinkSync(pack.source, link, "dir");
    } catch {
      /* race or dangling target: leave for the next reconcile */
    }
  }
}

/** Write (or remove when empty) the `<kind>/mcp.json` config listing the
 *  agent's MCP servers. `env`/secrets are intentionally NOT written to the
 *  workspace file (they stay DB-side); stdio servers with env-based auth
 *  need a future secret mount (ADR 0003 consequence). */
export function writeMcpConfig(
  workspacePath: string,
  kind: string,
  servers: readonly McpServerEntry[],
): void {
  const dir = join(workspacePath, KIND_DIR[kind] ?? `.${kind}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  if (servers.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      /* not present */
    }
    return;
  }
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    const entry: Record<string, unknown> = { type: s.transport };
    if (s.transport === "sse" && s.url) entry.url = s.url;
    if (s.transport === "stdio" && s.command) entry.command = s.command;
    mcpServers[s.name] = entry;
  }
  writeFileSync(
    path,
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers,
      },
      null,
      2,
    ),
  );
}

/** The full bridge reconcile (ADR 0003 decision 3): skills + mcp for one
 *  agent's workspace, gated by its current kind. Knowledge provisioning is
 *  a future resource type (the knowledge/ dir is seeded + referenced by
 *  AGENTS.md today). */
export function reconcileAgentResources(input: {
  workspacePath: string;
  kind: string;
  skillPacks: readonly SkillLink[];
  mcpServers: readonly McpServerEntry[];
}): void {
  reconcileSkillLinks(input.workspacePath, input.kind, input.skillPacks);
  writeMcpConfig(input.workspacePath, input.kind, input.mcpServers);
}

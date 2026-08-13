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
import { knowledgePackIndex } from "../knowledge/install.js";
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
  args?: string[];
  /** Auth headers (e.g. the product-tools bearer token). Written into
   *  the workspace .mcp.json — same exposure as the adapter's old write. */
  headers?: Record<string, string>;
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

/** Write (or remove when empty) the workspace-level `.mcp.json` (cwd) —
 *  the ONE config all three CLIs read natively (omp: cwd mcp.json/
 *  .mcp.json; pi: pi-mcp-adapter reads cwd .mcp.json; claude: passed via
 *  --mcp-config). User servers + the product-tools server merge here. */
export function writeMcpConfig(workspacePath: string, servers: readonly McpServerEntry[]): void {
  const path = join(workspacePath, ".mcp.json");
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
    if (s.transport === "stdio" && s.args && s.args.length > 0) entry.args = s.args;
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

/** Write the product-tool manifest (ADR 0003 decision 6): the coding agent
 *  child builds its tool table from `.agent/product-tools.json` — the
 *  run input no longer carries the manifest. Empty manifest = remove the
 *  file (no product tools). */
export function writeProductToolsManifest(
  workspacePath: string,
  manifest: readonly unknown[],
): void {
  const path = join(workspacePath, ".agent", "product-tools.json");
  if (manifest.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      /* not present */
    }
    return;
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Reconcile the workspace knowledge/ dir (ADR 0022): symlink each
 *  assigned pack + regenerate the machine index (pack summaries + file
 *  lists). Idempotent; stale links are removed; a non-symlink entry is
 *  never clobbered. */
export function reconcileKnowledgeResources(
  workspacePath: string,
  packs: ReadonlyArray<{ id: string; source: string; name: string; description: string }>,
): void {
  const root = join(workspacePath, "knowledge");
  mkdirSync(root, { recursive: true });
  const wanted = new Set(packs.map((p) => p.id));
  for (const entry of readdirSync(root)) {
    if (entry === "index.md") continue;
    const full = join(root, entry);
    try {
      if (lstatSync(full).isSymbolicLink() && !wanted.has(entry)) unlinkSync(full);
    } catch {
      /* non-symlink user entries stay */
    }
  }
  const sections: string[] = [
    "# Knowledge",
    "",
    "Agent 知识库索引(桥接生成,reconcile 时重建)。",
    "",
  ];
  for (const p of packs) {
    const slot = join(root, p.id);
    if (!existsSync(p.source)) continue;
    if (!existsSync(slot) && !lstatSyncSafe(slot)) {
      symlinkSync(p.source, slot, "dir");
    }
    sections.push(
      knowledgePackIndex({ name: p.name, description: p.description, installedRef: p.source }),
    );
    sections.push("");
  }
  writeFileSync(join(root, "index.md"), sections.join("\n"));
}

function lstatSyncSafe(p: string): boolean {
  try {
    return lstatSync(p) !== undefined;
  } catch {
    return false;
  }
}

/** The full bridge reconcile (ADR 0020 decision 3): skills + mcp +
 *  product tools + knowledge for one agent's workspace. */
export function reconcileAgentResources(input: {
  workspacePath: string;
  kind: string;
  skillPacks: readonly SkillLink[];
  mcpServers: readonly McpServerEntry[];
  productTools: readonly unknown[];
  knowledgePacks: ReadonlyArray<{
    id: string;
    source: string;
    name: string;
    description: string;
  }>;
}): void {
  reconcileSkillLinks(input.workspacePath, input.kind, input.skillPacks);
  writeMcpConfig(input.workspacePath, input.mcpServers);
  writeProductToolsManifest(input.workspacePath, input.productTools);
  reconcileKnowledgeResources(input.workspacePath, input.knowledgePacks);
}

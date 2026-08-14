import { mkdir, readFile, writeFile } from "node:fs/promises";

/** Per-kind project config dirs (the coding agent's cwd-level config).
 *  Seeded as empty placeholders; skills are symlinked into <dir>/skills
 *  and MCP servers written to <dir>/mcp.json by the workspace bridge. */
export const CONFIG_DIRS = [".agent", ".pi", ".omp", ".claude"] as const;

const AGENTS_MD = [
  "# Agent 工作区",
  "",
  "本目录是此 Agent 的运行工作区(coding agent 的 cwd)。",
  "身份与人格见 SOUL.md;机器可读清单见 manifest.json。",
  "",
  "## 知识库",
  "",
  "需要本项目使用说明、领域知识或约定时,先读 knowledge/ 目录下相关文件再作答。",
  "",
  "## 产品账本(对话历史)",
  "",
  "本对话的历史经 MCP 的 product-tools server 查询(history_recent / history_search / history_around);需要历史上下文时用它,不要凭记忆猜。",
  "",
].join("\n");

/** Default workspace files seeded on agent creation (agent-hub 预留口).
 *  Each is written ONLY when absent — never clobber a user's edits.
 *  CLAUDE.md mirrors AGENTS.md (claude reads CLAUDE.md, not AGENTS.md). */
const DEFAULT_FILES: Record<string, string> = {
  "agent.yml":
    "# Agent workspace descriptor (agent-hub 预留口).\n# 字段随 agent-hub 演进;当前仅作占位。\n",
  "AGENTS.md": `${AGENTS_MD}\n`,
  "CLAUDE.md": `${AGENTS_MD}\n`,
  "manifest.json": '{\n  "version": 1\n}\n',
  "SOUL.md": "# SOUL\n\n在此描述此 Agent 的身份、人格与行为准则。\n",
};

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Seed the default workspace layout: files, per-kind config dirs and the
 *  knowledge base. Idempotent — existing files/dirs are untouched. */
export async function seedAgentWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    ...Object.entries(DEFAULT_FILES).map(async ([name, content]) => {
      const path = `${dir}/${name}`;
      if (await exists(path)) return;
      await writeFile(path, content, "utf-8");
    }),
    mkdir(`${dir}/knowledge`, { recursive: true }),
    ...CONFIG_DIRS.map((d) => mkdir(`${dir}/${d}/skills`, { recursive: true })),
  ]);
}

/** Materialize an agent workspace directory (mkdir -p) and seed defaults. */
export async function ensureAgentWorkspace(dir: string): Promise<string> {
  await seedAgentWorkspace(dir);
  return dir;
}

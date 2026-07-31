import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetaSectionProvider, Plugin, PluginTool } from "@my-agent-team/agent";

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly relativePath: string;
}

export interface ProgressiveSkillOptions {
  readonly roots: readonly string[];
}

/** Scan configured roots for SKILL.md files, parse frontmatter for
 *  name + description. Deterministic order by root then name. */
export function buildSkillIndex(roots: readonly string[]): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  for (const root of roots) {
    scanDir(root, root, entries);
  }
  // Deterministic: sort by root then name
  entries.sort((a, b) =>
    a.root === b.root ? a.name.localeCompare(b.name) : a.root.localeCompare(b.root),
  );
  return entries;
}

function scanDir(root: string, currentDir: string, entries: SkillIndexEntry[]): void {
  let items: string[];
  try {
    items = readdirSync(currentDir);
  } catch {
    return;
  }

  for (const item of items) {
    const fullPath = join(currentDir, item);
    if (item === "SKILL.md") {
      const parsed = parseFrontmatter(fullPath);
      if (parsed) {
        entries.push({
          name: parsed.name,
          description: parsed.description,
          root,
          relativePath: fullPath.slice(root.length + 1),
        });
      }
      continue;
    }
    // Recurse into subdirectories (max depth 3 to avoid deep scans)
    const depth = currentDir.split("/").length - root.split("/").length;
    if (depth < 3) {
      try {
        const stat = readdirSync(fullPath);
        if (stat.length > 0) scanDir(root, fullPath, entries);
      } catch {
        /* not a dir */
      }
    }
  }
}

function parseFrontmatter(path: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const frontmatter = match[1] ?? "";
    const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim();
    const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
    if (!name) return null;
    return { name, description: description ?? "" };
  } catch {
    return null;
  }
}

/** Create the progressive-skill Plugin: Meta index + skill_load tool. */
export function createProgressiveSkillPlugin(opts: ProgressiveSkillOptions): Plugin {
  const index = buildSkillIndex(opts.roots);

  const metaProvider: MetaSectionProvider = {
    name: "Skills",
    render(): string {
      if (index.length === 0) return "No skills available.";
      return index.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
    },
  };

  const skillLoadTool: PluginTool = {
    name: "skill_load",
    description:
      "Load the full body of a skill by name. Only the name/description is in the index; use this to read the actual instructions.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from the index" } },
      required: ["name"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> {
      const name = args.name as string;
      const entry = index.find((s) => s.name === name);
      if (!entry) return { error: `Skill "${name}" not found` };

      // Resolve and validate path within root
      const fullPath = resolve(entry.root, entry.relativePath);
      // Prevent escape: must start with root
      if (!fullPath.startsWith(resolve(entry.root))) {
        return { error: "Path escape detected" };
      }
      if (!existsSync(fullPath)) return { error: `Skill file not found` };

      const content = readFileSync(fullPath, "utf8");
      // Strip frontmatter, resolve ${SKILL_DIR}
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const skillDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      return {
        name: entry.name,
        body: body.replaceAll("${SKILL_DIR}", skillDir),
      } as unknown as Readonly<Record<string, unknown>>;
    },
  };

  return {
    name: "progressive-skill",
    tools: [skillLoadTool],
    meta: [metaProvider],
  };
}

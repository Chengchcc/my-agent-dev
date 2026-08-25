import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MetaSectionProvider, Plugin, PluginTool } from "../agent-runtime.js";
import { buildSkillIndex, type SkillIndexEntry } from "./index.js";

export interface SkillOptions {
  readonly roots: readonly string[];
}

function isWithinRoot(root: string, target: string): boolean {
  try {
    const real = realpathSync(target);
    return real === root || real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/** Create the oma skill module: Meta index + skill_load tool.
 *  Absorbed from @chengchenccc/plugin-progressive-skill; the shared index
 *  builder now lives in ./skills.ts (tools-common merged into oma). Skill loading is
 *  progressive by definition: the index stays in context, the body loads
 *  on demand. */
export function createSkill(opts: SkillOptions): Plugin {
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
      "Load the full body of a skill by name. Only the name/description is in the index; use this to read the actual instructions. Relative paths in the body resolve against the returned `dir`.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from the index" } },
      required: ["name"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> {
      const name = args.name;
      if (typeof name !== "string") return { error: "Skill name must be a string" };
      const entry: SkillIndexEntry | undefined = index.find((s) => s.name === name);
      if (!entry) return { error: `Skill "${name}" not found` };

      const fullPath = resolve(entry.root, entry.relativePath);
      if (!isWithinRoot(entry.root, fullPath)) {
        return { error: "Path escape detected" };
      }
      if (!existsSync(fullPath)) return { error: `Skill file not found` };

      const content = readFileSync(fullPath, "utf8");
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const skillDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      return {
        name: entry.name,
        dir: skillDir,
        hint: "Resolve relative paths and scripts against `dir`.",
        body: body.replaceAll("${SKILL_DIR}", skillDir),
      };
    },
  };

  return {
    name: "progressive-skill",
    tools: [skillLoadTool],
    meta: [metaProvider],
  };
}

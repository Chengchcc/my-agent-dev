import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineContext, type Plugin } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";
import type { AgentFsLike } from "@my-agent-team/tools-common";
import { loadSkillIndexWithMtimeCache, type SkillMeta } from "./cache.js";
import { skillLoadTool } from "./skill-load.js";

/** Context key for skill index. progressive-skill writes, metaContext reads. */
export const SkillIndexKey = defineContext<string>("skill-index");
function nodeFsAdapter(cwd: string): AgentFsLike {
  return {
    async read(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return [];
        return readdirSync(full);
      } catch {
        return [];
      }
    },
    async stat(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(path: string) {
      const full = resolve(cwd, path);
      return full.startsWith(cwd) && existsSync(full);
    },
    async mkdirp(path: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
    },
  };
}

export interface ProgressiveSkillOptions {
  ws?: AgentFsLike;
  /** Workspace root directory. When provided, creates a node:fs adapter internally. */
  cwd?: string;
  /** Single root (backward compat). Use `roots` for multi-domain. */
  root?: string;
  /** Multiple roots in priority order (later overrides earlier on name collision). */
  roots?: string[];
  /** POSIX path prefix for the skill root. When set, ${SKILL_DIR} is replaced
   *  with this prefix + relative path instead of the logical path.
   *  e.g. posixSkillRoot="/var/agents/abc/private/skills", logical root="/skills/"
   *  -> "${SKILL_DIR}/extract.py" becomes "/var/agents/abc/private/skills/pdf-extract/extract.py" */
  posixSkillRoot?: string;
}

export function progressiveSkillPlugin(options: ProgressiveSkillOptions): Plugin {
  const ws = options.ws ?? (options.cwd ? nodeFsAdapter(options.cwd) : undefined);
  if (!ws) throw new Error("progressiveSkillPlugin: either ws or cwd must be provided");
  const roots = options.roots ?? [options.root ?? "/skills/"];
  const posixSkillRoot = options.posixSkillRoot;

  return {
    name: "progressive-skill",
    tools: [skillLoadTool({ ws, roots, posixSkillRoot })],
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        let skills: SkillMeta[];
        try {
          skills = await loadSkillIndexWithMtimeCache(ws, roots, ctx.logger);
        } catch (err) {
          ctx.logger.warn("progressive-skill: load failed, skipping injection", err);
          return [...messages];
        }

        if (skills.length === 0) return [...messages];

        // Write skill index to context store for metaContext to pick up.
        // No longer appended to system message - moved to meta user message.
        const indexBlock = renderIndex(skills.filter((s) => !s.disableModelInvocation));
        ctx.context.set(SkillIndexKey, indexBlock);

        return [...messages];
      },
    },
  };
}

function renderIndex(skills: { name: string; description: string }[]): string {
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);
  return `<available-skills>
${lines.join("\n")}

Call \`skill_load(name)\` to load the full instructions for a skill before using it.
</available-skills>`;
}

/** Find and load a skill by name, bypassing the model's tool_call path.
 *  Works for ALL skills including those with disableModelInvocation: true.
 *  Returns the skill body (with ${SKILL_DIR} resolved) or null if not found. */
export async function findSkillByName(
  opts: ProgressiveSkillOptions,
  name: string,
): Promise<{ skill: SkillMeta; body: string } | null> {
  const ws = opts.ws ?? (opts.cwd ? nodeFsAdapter(opts.cwd) : undefined);
  if (!ws) throw new Error("progressiveSkillPlugin: either ws or cwd must be provided");
  const roots = opts.roots ?? [opts.root ?? "/skills/"];
  const posixSkillRoot = opts.posixSkillRoot;

  const skills = await loadSkillIndexWithMtimeCache(ws, roots);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;

  const raw = (await ws.read(skill.skillMdPath)) ?? "";
  const body = raw.slice(skill.bodyOffset);

  // Resolve ${SKILL_DIR}
  let resolved = body;
  if (posixSkillRoot) {
    const posixRoot = posixSkillRoot.endsWith("/") ? posixSkillRoot.slice(0, -1) : posixSkillRoot;
    const logicalRoot = (roots[roots.length - 1] ?? "/skills/").replace(/\/$/, "");
    resolved = body.replaceAll("${SKILL_DIR}", skill.dir.replace(logicalRoot, posixRoot));
  }

  return { skill, body: resolved };
}

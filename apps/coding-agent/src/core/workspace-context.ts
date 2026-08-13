import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** cwd-based workspace context (ADR 0003 decision 6): the coding agent's
 *  meta lives in workspace files, read natively — no run-input injection.
 *  Only used as the FALLBACK when the run input does not carry explicit
 *  values (Loop scopes still pass their own LOOP.md config). */

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** The system prompt = AGENTS.md (instructions) + SOUL.md (identity) +
 *  USER.md (user context), in that order, joined. */
export function readWorkspaceSystemPrompt(cwd: string): string | undefined {
  const parts = ["AGENTS.md", "SOUL.md", "USER.md"]
    .map((f) => readTextOrNull(join(cwd, f)))
    .filter((t): t is string => t !== null && t.trim() !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Skill roots = every directory under .agent/skills (symlinked packs via
 *  the workspace bridge). Each is scanned for SKILL.md by the progressive
 *  skill plugin. */
export function scanWorkspaceSkillRoots(cwd: string): string[] {
  const skillsDir = join(cwd, ".agent", "skills");
  if (!existsSync(skillsDir)) return [];
  const roots: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const p = join(skillsDir, entry);
    try {
      if (statSync(p).isDirectory()) roots.push(p);
    } catch {
      /* dangling symlink or race: skip */
    }
  }
  return roots;
}

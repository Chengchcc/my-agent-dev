import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Project-level oma settings (`.oma/settings.json` in the workspace root).
 *  Standalone TUI-only. The product backend keeps agent.yml as its model
 *  truth and can be overridden per-run by the run parameter, so this file
 *  never conflicts with agent.yml in the backend->oma chain. */
export interface ProjectSettings {
  /** Canonical `<provider>/<model>` id chosen in the TUI. */
  model?: string;
  /** Configured skill root dirs (absolute, or relative to the workspace
   *  root). When present, overrides the default project/global discovery;
   *  empty/absent falls back to defaults. */
  skills?: string[];
  /** Read Claude Code skill dirs (`.claude/skills` + `~/.claude/skills`). */
  enableClaude?: boolean;
  /** Read Codex CLI skill dirs (`.codex/skills` + `~/.codex/skills`). */
  enableCodex?: boolean;
  /** Read agent skill dirs (`.agent/skills` / `.agents/skills` + home). */
  enableAgents?: boolean;
  /** Loop step cap (env OMA_MAX_STEPS). */
  maxSteps?: number;
  /** Single model-call timeout ms (env OMA_MODEL_TIMEOUT_MS). */
  modelTimeoutMs?: number;
  /** MCP call timeout ms (env OMA_MCP_TIMEOUT_MS). */
  mcpTimeoutMs?: number;
  /** Disable web tools (env OMA_DISABLE_WEB=1). */
  disableWeb?: boolean;
  /** Generate auto titles (env OMA_TITLE_ENABLED=0 disables). */
  titleEnabled?: boolean;
  /** Run autonomous memory extraction (env OMA_MEMORY_EXTRACT=0 disables). */
  memoryExtract?: boolean;
  /** Memory extraction model (env OMA_MEMORY_MODEL). */
  memoryModel?: string;
}

function settingsPath(root: string): string {
  return join(root, ".oma", "settings.json");
}

/** Read project settings. Missing/corrupt file degrades to `{}`. */
export function loadProjectSettings(root: string): ProjectSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(root), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: ProjectSettings = {};
    if ("model" in parsed && typeof parsed.model === "string") result.model = parsed.model;
    if ("skills" in parsed && Array.isArray(parsed.skills)) {
      const skills = parsed.skills;
      if (skills.every((s) => typeof s === "string")) result.skills = skills;
    }
    if ("enableClaude" in parsed && typeof parsed.enableClaude === "boolean") {
      result.enableClaude = parsed.enableClaude;
    }
    if ("enableCodex" in parsed && typeof parsed.enableCodex === "boolean") {
      result.enableCodex = parsed.enableCodex;
    }
    if ("enableAgents" in parsed && typeof parsed.enableAgents === "boolean") {
      result.enableAgents = parsed.enableAgents;
    }
    if ("maxSteps" in parsed && typeof parsed.maxSteps === "number")
      result.maxSteps = parsed.maxSteps;
    if ("modelTimeoutMs" in parsed && typeof parsed.modelTimeoutMs === "number") {
      result.modelTimeoutMs = parsed.modelTimeoutMs;
    }
    if ("mcpTimeoutMs" in parsed && typeof parsed.mcpTimeoutMs === "number") {
      result.mcpTimeoutMs = parsed.mcpTimeoutMs;
    }
    if ("disableWeb" in parsed && typeof parsed.disableWeb === "boolean") {
      result.disableWeb = parsed.disableWeb;
    }
    if ("titleEnabled" in parsed && typeof parsed.titleEnabled === "boolean") {
      result.titleEnabled = parsed.titleEnabled;
    }
    if ("memoryExtract" in parsed && typeof parsed.memoryExtract === "boolean") {
      result.memoryExtract = parsed.memoryExtract;
    }
    if ("memoryModel" in parsed && typeof parsed.memoryModel === "string") {
      result.memoryModel = parsed.memoryModel;
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist a full settings object to `.oma/settings.json`, preserving any
 *  unknown keys already present in the file. */
export function saveProjectSettings(root: string, settings: ProjectSettings): void {
  const path = settingsPath(root);
  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) existing = raw as Record<string, unknown>;
  } catch {
    /* no existing file */
  }
  mkdirSync(join(root, ".oma"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`, "utf8");
}

/** Persist a TUI model choice to `.oma/settings.json`, preserving other keys. */
export function saveProjectModel(root: string, modelId: string): void {
  const current = loadProjectSettings(root);
  saveProjectSettings(root, { ...current, model: modelId });
}

/** True when the file exists (used by tests to assert a write happened). */
export function hasProjectSettings(root: string): boolean {
  return existsSync(settingsPath(root));
}

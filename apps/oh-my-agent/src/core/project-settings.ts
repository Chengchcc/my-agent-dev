import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Project-level oma settings (`.oma/settings.json` in the workspace root).
 *  Standalone TUI-only. The product backend keeps agent.yml as its model
 *  truth and can be overridden per-run by the run parameter, so this file
 *  never conflicts with agent.yml in the backend->oma chain. */
export interface ProjectSettings {
  /** Canonical `<provider>/<model>` id chosen in the TUI. */
  model?: string;
}

function settingsPath(root: string): string {
  return join(root, ".oma", "settings.json");
}

/** Read project settings. Missing/corrupt file degrades to `{}`. */
export function loadProjectSettings(root: string): ProjectSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(root), "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null) {
      const model = (raw as { model?: unknown }).model;
      if (typeof model === "string") return { model };
    }
    return {};
  } catch {
    return {};
  }
}

/** Persist a TUI model choice to `.oma/settings.json`, preserving other keys. */
export function saveProjectModel(root: string, modelId: string): void {
  const current = loadProjectSettings(root);
  mkdirSync(join(root, ".oma"), { recursive: true });
  writeFileSync(
    settingsPath(root),
    JSON.stringify({ ...current, model: modelId }, null, 2),
    "utf8",
  );
}

/** True when the file exists (used by tests to assert a write happened). */
export function hasProjectSettings(root: string): boolean {
  return existsSync(settingsPath(root));
}

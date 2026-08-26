import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginHooks, PluginTool } from "../runtime/plugin.js";

const KNOWN_HOOK_KEYS = new Set([
  "beforeRun",
  "afterRun",
  "beforeModel",
  "afterModel",
  "beforeTool",
  "afterTool",
  "transformToolArgs",
  "beforeStop",
  "afterStop",
]);

export interface PluginCodeResult {
  readonly ok: boolean;
  readonly tools?: readonly PluginTool[];
  readonly hooks?: PluginHooks;
  readonly warnings: readonly string[];
  readonly error?: string;
}

function isPluginToolLike(v: unknown): v is PluginTool {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.name === "string" &&
    typeof t.description === "string" &&
    typeof t.execute === "function"
  );
}

/** Load ONE code entry (tools or hooks) from an installed plugin root.
 *  Never throws: any failure degrades to {ok:false, error} (spec failure
 *  semantics — a broken plugin must never fail the Run). */
export async function loadPluginCode(root: string, entry: string): Promise<PluginCodeResult> {
  const file = join(root, entry);
  let mod: Record<string, unknown>;
  try {
    // Bun-native dynamic import: TS transpiles natively, no jiti (spec).
    // The import itself executes module top-level code — plugin bugs surface
    // here as caught errors, not oma crashes.
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      error: `failed to import ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const warnings: string[] = [];

  const toolsExport = mod.tools ?? (mod.default as unknown);
  if (toolsExport !== undefined) {
    if (!Array.isArray(toolsExport) || !toolsExport.every(isPluginToolLike)) {
      return { ok: false, warnings, error: `${entry}: tools export must be PluginTool[]` };
    }
    return { ok: true, tools: toolsExport, warnings };
  }

  const hooksExport = mod.hooks ?? mod.default;
  if (typeof hooksExport === "object" && hooksExport !== null) {
    const src = hooksExport as Record<string, unknown>;
    const hooks: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (KNOWN_HOOK_KEYS.has(k)) hooks[k] = v;
      else warnings.push(`${entry}: unknown hook key "${k}" ignored`);
    }
    return { ok: true, hooks: hooks as PluginHooks, warnings };
  }

  return { ok: false, warnings, error: `${entry}: no tools/hooks export found` };
}

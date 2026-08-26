import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginHooks, PluginTool } from "../runtime/plugin.js";
import { loadPluginCode } from "./plugin-code.js";
import { listInstalledPlugins } from "./plugin-marketplace.js";
import { isFileTrusted, isPluginTrusted, readTrustedPlugins } from "./plugin-trust.js";
export type OmaMode = "tui" | "print" | "json" | "rpc";

export interface CodeEntry {
  readonly name: string;
  readonly root: string;
  readonly toolsEntry?: string;
  readonly hooksEntry?: string;
}

/** A plugin's .mcp.json servers, gated identically to code entries. */
export interface PluginMcpConfig {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly scope: "user" | "project";
  readonly servers: Record<string, unknown>;
}

export interface ResolvedComponents {
  readonly codeEntries: readonly CodeEntry[];
  readonly mcpServers: readonly PluginMcpConfig[];
  readonly warnings: readonly string[];
}

function readPluginMcp(root: string): Record<string, unknown> | null {
  const path = join(root, ".mcp.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed.mcpServers ?? null;
  } catch {
    return null;
  }
}

/** Policy layer (spec): scope x mode trust matrix. Pure — no imports, no
 *  code loading. The runtime never sees this; it only mounts what wins. */
export function resolvePluginComponents(workspaceRoot: string, mode: OmaMode): ResolvedComponents {
  const warnings: string[] = [];
  const trusted = readTrustedPlugins();
  const codeEntries: CodeEntry[] = [];
  const mcpServers: PluginMcpConfig[] = [];

  for (const p of listInstalledPlugins(workspaceRoot)) {
    if (!p.enabled) continue;
    warnings.push(...(p.manifestWarnings ?? []).map((w) => `${p.name}: ${w}`));
    const hasCode = Boolean(p.toolsEntry || p.hooksEntry);
    const mcp = p.hasMcpJson ? readPluginMcp(p.root) : null;
    if (!hasCode && !mcp) continue;

    if (p.scope === "project") {
      if (mode === "rpc") {
        warnings.push(`${p.name}: project-scope code components never load in rpc mode`);
        continue;
      }
      if (!isPluginTrusted(p.root, trusted)) {
        warnings.push(
          `${p.name}: project-scope code components untrusted (hash mismatch or no record); run /plugin trust ${p.name} to approve`,
        );
        continue;
      }
    }
    if (hasCode) {
      codeEntries.push({
        name: p.name,
        root: p.root,
        ...(p.toolsEntry ? { toolsEntry: p.toolsEntry } : {}),
        ...(p.hooksEntry ? { hooksEntry: p.hooksEntry } : {}),
      });
    }
    if (mcp) {
      mcpServers.push({ pluginName: p.name, pluginRoot: p.root, scope: p.scope, servers: mcp });
    }
  }
  return { codeEntries, mcpServers, warnings };
}

export interface AssembledPluginRuntime {
  readonly plugins: readonly Plugin[];
  readonly mcpServers: readonly PluginMcpConfig[];
  readonly warnings: readonly string[];
}

/** Mode-layer entry: resolve policy + load approved code. The ONLY function
 *  modes call (spec: policy in mode layer, runtime mounts only). */
export async function assemblePluginRuntime(
  workspaceRoot: string,
  mode: OmaMode,
): Promise<AssembledPluginRuntime> {
  const resolved = resolvePluginComponents(workspaceRoot, mode);
  const warnings = [...resolved.warnings];
  // Standalone trust gate (spec follow-up): the workspace's own .mcp.json is
  // repo-controlled; untrusted content mounts nothing (run-runtime enforces)
  // and the warning tells the user how to approve it. RPC skips this — the
  // product writes that file.
  if (mode !== "rpc") {
    const mcpJsonPath = join(workspaceRoot, ".mcp.json");
    if (existsSync(mcpJsonPath) && !isFileTrusted(mcpJsonPath, readTrustedPlugins())) {
      warnings.push(
        "workspace .mcp.json untrusted: servers not mounted; run /mcp trust to approve this file",
      );
    }
  }
  const plugins: Plugin[] = [];
  for (const entry of resolved.codeEntries) {
    const tools: PluginTool[] = [];
    let hooks: PluginHooks | undefined;
    if (entry.toolsEntry) {
      const r = await loadPluginCode(entry.root, entry.toolsEntry);
      if (r.ok && r.tools) tools.push(...r.tools);
      else warnings.push(`${entry.name}: ${r.error ?? "tools entry failed"}`);
      warnings.push(...r.warnings.map((w) => `${entry.name}: ${w}`));
    }
    if (entry.hooksEntry) {
      const r = await loadPluginCode(entry.root, entry.hooksEntry);
      if (r.ok && r.hooks) hooks = r.hooks;
      else warnings.push(`${entry.name}: ${r.error ?? "hooks entry failed"}`);
      warnings.push(...r.warnings.map((w) => `${entry.name}: ${w}`));
    }
    if (tools.length > 0 || hooks) {
      plugins.push({
        name: `plugin:${entry.name}`,
        ...(tools.length > 0 ? { tools } : {}),
        ...(hooks ? { hooks } : {}),
      });
    }
  }
  return { plugins, mcpServers: resolved.mcpServers, warnings };
}

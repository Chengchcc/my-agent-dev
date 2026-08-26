import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Relative directory containing SKILL.md bundles (default "skills"). */
  readonly skills?: string;
  /** Relative directory containing markdown slash commands (reserved). */
  readonly commands?: string;
  /** oma code entry (spec): module exporting PluginTool[] (default export ok). */
  readonly toolsEntry?: string;
  /** oma code entry (spec): module exporting PluginHooks (default export ok). */
  readonly hooksEntry?: string;
  /** Non-fatal conflict/compat notes surfaced to the user (spec conflict matrix). */
  readonly warnings: readonly string[];
}

export interface MarketplacePluginEntry {
  readonly name: string;
  readonly path: string;
  readonly version?: string;
}

export interface MarketplaceManifest {
  readonly name: string;
  readonly plugins: readonly MarketplacePluginEntry[];
}

export interface MarketplaceRecord {
  readonly name: string;
  readonly source: string;
  readonly root: string;
}

export interface InstalledPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly sourceMarketplace: string;
  readonly scope: "user" | "project";
  readonly enabled: boolean;
  readonly root: string;
  readonly skillsDir?: string;
  /** oma code entry (spec): module exporting PluginTool[]. */
  readonly toolsEntry?: string;
  /** oma code entry (spec): module exporting PluginHooks. */
  readonly hooksEntry?: string;
  /** Plugin bundles a .mcp.json (mounted via mcp-mount when trusted). */
  readonly hasMcpJson?: boolean;
  /** Non-fatal manifest conflict notes (spec conflict matrix); always set by
   *  listInstalledPlugins, absent in persisted registry records. */
  readonly manifestWarnings?: readonly string[];
}

interface PersistedRegistry {
  marketplaces: MarketplaceRecord[];
  plugins: Array<Omit<InstalledPlugin, "description">>;
}

function userRegistryPath(): string {
  return join(agentDir(), "plugins.json");
}

function projectRegistryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "plugins.json");
}

function readRegistry(path: string): PersistedRegistry {
  if (!existsSync(path)) return { marketplaces: [], plugins: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as { marketplaces?: unknown; plugins?: unknown };
      const marketplaces = Array.isArray(obj.marketplaces) ? obj.marketplaces : [];
      const plugins = Array.isArray(obj.plugins) ? obj.plugins : [];
      return {
        marketplaces: marketplaces.filter(isMarketplaceRecord),
        plugins: plugins.filter(isInstalledPluginRecord),
      };
    }
  } catch {
    /* corrupt registry: start empty */
  }
  return { marketplaces: [], plugins: [] };
}

function isMarketplaceRecord(v: unknown): v is MarketplaceRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { name?: unknown; source?: unknown; root?: unknown };
  return typeof o.name === "string" && typeof o.source === "string" && typeof o.root === "string";
}

function isInstalledPluginRecord(v: unknown): v is Omit<InstalledPlugin, "description"> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    name?: unknown;
    sourceMarketplace?: unknown;
    scope?: unknown;
    enabled?: unknown;
    root?: unknown;
  };
  return (
    typeof o.name === "string" &&
    typeof o.sourceMarketplace === "string" &&
    (o.scope === "user" || o.scope === "project") &&
    typeof o.enabled === "boolean" &&
    typeof o.root === "string"
  );
}

function writeRegistry(path: string, registry: PersistedRegistry): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export function loadMarketplaceManifest(root: string): MarketplaceManifest | null {
  const path = join(root, "marketplace.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as { name?: unknown; plugins?: unknown };
    if (typeof o.name !== "string" || !Array.isArray(o.plugins)) return null;
    const plugins = o.plugins.filter(
      (p): p is MarketplacePluginEntry =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as MarketplacePluginEntry).name === "string" &&
        typeof (p as MarketplacePluginEntry).path === "string",
    );
    return { name: o.name, plugins };
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/** Multi-source manifest read (spec: oma plugin.json → .claude-plugin/plugin.json
 *  → package.json omp/pi field) with the conflict matrix. */
export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const warnings: string[] = [];
  const oma = readJson(join(pluginRoot, "plugin.json"));
  const claude = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const pkg = readJson(join(pluginRoot, "package.json"));
  const ompField = pkg ? (pkg.omp ?? pkg.pi) : undefined;
  const omp =
    typeof ompField === "object" && ompField !== null
      ? (ompField as Record<string, unknown>)
      : null;

  const primary = oma ?? claude ?? (pkg && str(pkg, "name") ? { name: str(pkg, "name") } : null);
  if (!primary || typeof primary.name !== "string") return null;

  if (oma && claude) {
    warnings.push(
      "dual manifest: oma plugin.json wins; .claude-plugin/plugin.json fills missing metadata only",
    );
  }
  if (omp) {
    if (typeof omp.tools === "string" || typeof omp.hooks === "string") {
      warnings.push(
        "omp/pi manifest code entries (tools/hooks) are not executed by oma; provide oma plugin.json tools/hooks entries instead",
      );
    }
  }
  if (claude?.hooks !== undefined) {
    warnings.push(
      "claude hooks config detected and ignored: hooks run through the oma hooks entry only",
    );
  }
  if (claude?.commands !== undefined) warnings.push("claude commands/ component ignored");
  if (claude?.agents !== undefined) warnings.push("claude agents/ component ignored");

  const result: {
    name: string;
    version?: string;
    description?: string;
    skills?: string;
    toolsEntry?: string;
    hooksEntry?: string;
    warnings: string[];
  } = { name: primary.name, warnings };
  const fill = (src: Record<string, unknown> | null) => {
    if (!src) return;
    result.version ??= str(src, "version");
    result.description ??= str(src, "description");
    result.skills ??= str(src, "skills");
  };
  fill(oma);
  fill(claude);
  fill(pkg);
  // oma-only code entries — never sourced from omp/claude fields (spec).
  if (oma) {
    const t = str(oma, "tools");
    if (t) result.toolsEntry = t;
    const h = str(oma, "hooks");
    if (h) result.hooksEntry = h;
  }
  return result;
}

function marketplaceSourceToRoot(source: string): { root: string; ok: boolean; error?: string } {
  if (existsSync(source)) {
    return { root: source, ok: true };
  }
  const cacheDir = join(agentDir(), "marketplace-cache");
  mkdirSync(cacheDir, { recursive: true });
  const slug = source.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
  const root = join(cacheDir, slug);
  const proc = Bun.spawnSync(["git", "clone", "--depth", "1", source, root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.exitCode !== 0) {
    return { root, ok: false, error: proc.stderr.toString().trim() || `failed to clone ${source}` };
  }
  return { root, ok: true };
}

export function listMarketplaces(workspaceRoot: string): MarketplaceRecord[] {
  const user = readRegistry(userRegistryPath());
  const project = readRegistry(projectRegistryPath(workspaceRoot));
  const byName = new Map<string, MarketplaceRecord>();
  for (const m of user.marketplaces) byName.set(m.name, m);
  for (const m of project.marketplaces) byName.set(m.name, m);
  return Array.from(byName.values());
}

export function addMarketplace(
  workspaceRoot: string,
  source: string,
  scope: "user" | "project" = "user",
): { ok: boolean; error?: string; name?: string } {
  const { root, ok, error } = marketplaceSourceToRoot(source);
  if (!ok) return { ok: false, error };
  const manifest = loadMarketplaceManifest(root);
  if (!manifest) return { ok: false, error: `no marketplace.json in ${root}` };
  const path = scope === "user" ? userRegistryPath() : projectRegistryPath(workspaceRoot);
  const registry = readRegistry(path);
  const existing = registry.marketplaces.find((m) => m.name === manifest.name);
  if (existing) {
    registry.marketplaces = registry.marketplaces.map((m) =>
      m.name === manifest.name ? { name: m.name, source, root } : m,
    );
  } else {
    registry.marketplaces.push({ name: manifest.name, source, root });
  }
  writeRegistry(path, registry);
  return { ok: true, name: manifest.name };
}

export function removeMarketplace(workspaceRoot: string, name: string): boolean {
  let removed = false;
  for (const [, path] of [
    ["user", userRegistryPath()],
    ["project", projectRegistryPath(workspaceRoot)],
  ] as const) {
    const registry = readRegistry(path);
    const before = registry.marketplaces.length;
    registry.marketplaces = registry.marketplaces.filter((m) => m.name !== name);
    if (registry.marketplaces.length !== before) {
      writeRegistry(path, registry);
      removed = true;
    }
  }
  return removed;
}

export function listInstalledPlugins(workspaceRoot: string): InstalledPlugin[] {
  const user = readRegistry(userRegistryPath());
  const project = readRegistry(projectRegistryPath(workspaceRoot));
  const byName = new Map<string, InstalledPlugin>();
  for (const p of [...user.plugins, ...project.plugins]) {
    if (p.scope === "user") byName.set(p.name, p);
  }
  for (const p of project.plugins) {
    if (p.scope === "project") byName.set(p.name, p);
  }
  return Array.from(byName.values()).map((p) => {
    const manifest = loadPluginManifest(p.root);
    return {
      ...p,
      description: manifest?.description,
      version: manifest?.version ?? p.version,
      skillsDir: manifest?.skills ? join(p.root, manifest.skills) : join(p.root, "skills"),
      toolsEntry: manifest?.toolsEntry,
      hooksEntry: manifest?.hooksEntry,
      hasMcpJson: existsSync(join(p.root, ".mcp.json")),
      manifestWarnings: manifest?.warnings ?? [],
    };
  });
}

export function installPlugin(
  workspaceRoot: string,
  ref: string,
  scope: "user" | "project" = "user",
): { ok: boolean; error?: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0) return { ok: false, error: "usage: /plugin install <marketplace>/<plugin>" };
  const marketplaceName = ref.slice(0, slash);
  const pluginName = ref.slice(slash + 1);
  const marketplace = listMarketplaces(workspaceRoot).find((m) => m.name === marketplaceName);
  if (!marketplace) return { ok: false, error: `marketplace not found: ${marketplaceName}` };
  const manifest = loadMarketplaceManifest(marketplace.root);
  const entry = manifest?.plugins.find((p) => p.name === pluginName);
  if (!entry) return { ok: false, error: `plugin not found: ${pluginName}` };
  const sourceRoot = join(marketplace.root, entry.path);
  const pluginManifest = loadPluginManifest(sourceRoot);
  if (!pluginManifest) return { ok: false, error: `no plugin.json in ${sourceRoot}` };

  const installRoot =
    scope === "user"
      ? join(agentDir(), "plugins", pluginName)
      : join(workspaceRoot, ".oma", "plugins", pluginName);
  if (existsSync(installRoot)) rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(join(installRoot, ".."), { recursive: true });
  cpSync(sourceRoot, installRoot, { recursive: true });

  const path = scope === "user" ? userRegistryPath() : projectRegistryPath(workspaceRoot);
  const registry = readRegistry(path);
  registry.plugins = registry.plugins.filter((p) => !(p.name === pluginName && p.scope === scope));
  registry.plugins.push({
    name: pluginName,
    version: pluginManifest.version,
    sourceMarketplace: marketplaceName,
    scope,
    enabled: true,
    root: installRoot,
  });
  writeRegistry(path, registry);
  return { ok: true };
}

export function uninstallPlugin(workspaceRoot: string, name: string): boolean {
  let removed = false;
  for (const [scope, path] of [
    ["user", userRegistryPath()],
    ["project", projectRegistryPath(workspaceRoot)],
  ] as const) {
    const registry = readRegistry(path);
    const before = registry.plugins.length;
    const removedPlugin = registry.plugins.find((p) => p.name === name && p.scope === scope);
    registry.plugins = registry.plugins.filter((p) => !(p.name === name && p.scope === scope));
    if (registry.plugins.length !== before) {
      writeRegistry(path, registry);
      if (removedPlugin) rmSync(removedPlugin.root, { recursive: true, force: true });
      removed = true;
    }
  }
  return removed;
}

export function setPluginEnabled(workspaceRoot: string, name: string, enabled: boolean): boolean {
  let changed = false;
  for (const [scope, path] of [
    ["user", userRegistryPath()],
    ["project", projectRegistryPath(workspaceRoot)],
  ] as const) {
    const registry = readRegistry(path);
    const rec = registry.plugins.find((p) => p.name === name && p.scope === scope);
    if (!rec || rec.enabled === enabled) continue;
    registry.plugins = registry.plugins.map((p) =>
      p.name === name && p.scope === scope ? { ...p, enabled } : p,
    );
    writeRegistry(path, registry);
    changed = true;
  }
  return changed;
}

/** Skill roots contributed by enabled installed plugins. */
export function enabledPluginSkillRoots(workspaceRoot: string): string[] {
  const plugins = listInstalledPlugins(workspaceRoot);
  const roots: string[] = [];
  for (const p of plugins) {
    if (!p.enabled || !p.skillsDir) continue;
    if (existsSync(p.skillsDir)) roots.push(p.skillsDir);
  }
  return roots;
}

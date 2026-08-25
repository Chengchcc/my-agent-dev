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

export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const path = join(pluginRoot, "plugin.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
      skills?: unknown;
    };
    if (typeof o.name !== "string") return null;
    const result: { name: string; version?: string; description?: string; skills?: string } = {
      name: o.name,
    };
    if (typeof o.version === "string") result.version = o.version;
    if (typeof o.description === "string") result.description = o.description;
    if (typeof o.skills === "string") result.skills = o.skills;
    return result;
  } catch {
    return null;
  }
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

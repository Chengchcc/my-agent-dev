import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILTIN_CATALOG,
  buildAllModels,
  type CatalogSpec,
  createProvider,
  type ModelRuntime,
  type ModelSpec,
  type ProviderSpec,
  parseCatalogYAML,
} from "@chengchenccc/ai";

/** Candidate file paths for runtime model config, in priority order. */
function catalogPaths(env: Record<string, string | undefined>): string[] {
  const paths: string[] = [];
  if (env.OMA_HOME) paths.push(join(env.OMA_HOME, "models.yml"));
  paths.push(join(homedir(), ".oma", "models.yml"));
  // H6: the CWD entry resolves into the agent-writable workspace when the
  // process is spawned by the product backend — a prompt-injected file
  // there could hijack provider baseUrl and exfiltrate API keys. The
  // backend sets OMA_WORKSPACE_CATALOG=0 for its children; standalone
  // (user-owned) sessions keep the CWD override.
  if (env.OMA_WORKSPACE_CATALOG !== "0") paths.push(resolve(".oma", "models.yml"));
  return paths;
}

/** Read and merge the first available runtime models.yml with BUILTIN_CATALOG.
 *  Returns BUILTIN_CATALOG unchanged if no file is found. */
export function loadRuntimeCatalog(
  env: Record<string, string | undefined> = process.env,
): CatalogSpec {
  for (const p of catalogPaths(env)) {
    if (!existsSync(p)) continue;
    const runtime = parseCatalogYAML(readFileSync(p, "utf-8"));
    return mergeCatalogs(BUILTIN_CATALOG, runtime);
  }
  return BUILTIN_CATALOG;
}

/** Deep-merge two catalogs: override providers/models win; new entries added.
 *  Provider-level fields (api, baseUrl, apiKeyEnv) are overridden when present.
 *  Within a provider, models merge by id. */
export function mergeCatalogs(base: CatalogSpec, override: CatalogSpec): CatalogSpec {
  const providers: Record<string, ProviderSpec> = { ...base.providers };
  for (const [pid, oSpec] of Object.entries(override.providers)) {
    const bSpec = providers[pid];
    providers[pid] = bSpec
      ? { ...bSpec, ...oSpec, models: mergeModelLists(bSpec.models, oSpec.models) }
      : oSpec;
  }
  return { providers };
}

function mergeModelLists(base: ModelSpec[], override: ModelSpec[]): ModelSpec[] {
  const byId = new Map<string, ModelSpec>();
  for (const m of base) byId.set(m.id, m);
  for (const m of override) byId.set(m.id, m);
  return [...byId.values()];
}

/** Register every provider in the catalog whose apiKey env var is set.
 *  Providers without credentials are silently skipped. */
export function registerProvidersFromCatalog(
  runtime: ModelRuntime,
  catalog: CatalogSpec,
  env: Record<string, string | undefined>,
): void {
  const built = buildAllModels(catalog);
  for (const [pid, entry] of Object.entries(built)) {
    const apiKey = resolveApiKey(pid, entry.spec.apiKeyEnv, entry.spec.apiKey, env);
    if (!apiKey) continue;
    const baseUrl = resolveBaseUrl(pid, entry.spec.baseUrl, env);
    runtime.registerProvider(
      createProvider({
        id: pid,
        name: pid,
        baseUrl,
        auth: { apiKey, ...(entry.spec.headers ? { headers: entry.spec.headers } : {}) },
        models: entry.models,
      }),
    );
  }
}

/** Resolve API key: env var first, then the provider's inline apiKey from
 *  models.yml, then provider-specific fallbacks (ANTHROPIC_AUTH_TOKEN as a
 *  fallback for ANTHROPIC_API_KEY — proxy users depend on it). */
function resolveApiKey(
  pid: string,
  primaryEnv: string,
  inlineApiKey: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const key = env[primaryEnv];
  if (key) return key;
  if (inlineApiKey) return inlineApiKey;
  // ponytail: anthropic-specific fallback, delete when ProviderSpec gets
  // a generic fallbackEnv field.
  if (pid === "anthropic") return env.ANTHROPIC_AUTH_TOKEN;
  return undefined;
}

/** Resolve baseUrl with env override (ANTHROPIC_BASE_URL for proxy setups). */
function resolveBaseUrl(
  pid: string,
  specBaseUrl: string,
  env: Record<string, string | undefined>,
): string {
  // ponytail: anthropic-specific override, delete when ProviderSpec gets
  // a generic baseUrlEnv field.
  if (pid === "anthropic" && env.ANTHROPIC_BASE_URL) return env.ANTHROPIC_BASE_URL;
  let url = specBaseUrl.trim().replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url;
}

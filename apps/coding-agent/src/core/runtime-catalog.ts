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
} from "@my-agent-team/ai";

/** Candidate file paths for runtime model config, in priority order. */
function catalogPaths(env: Record<string, string | undefined>): string[] {
  const paths: string[] = [];
  if (env.MY_AGENT_HOME) paths.push(join(env.MY_AGENT_HOME, "models.yml"));
  paths.push(join(homedir(), ".my-agent", "models.yml"));
  paths.push(resolve(".my-agent", "models.yml"));
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
    const apiKey = env[entry.spec.apiKeyEnv];
    if (!apiKey) continue;
    runtime.registerProvider(
      createProvider({
        id: pid,
        name: pid,
        baseUrl: entry.spec.baseUrl,
        auth: { apiKey },
        models: entry.models,
      }),
    );
  }
}

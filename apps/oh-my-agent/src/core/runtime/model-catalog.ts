import type { BackendModel, BackendModelCatalog } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";

/** Map the process ModelRuntime catalog to the Backend model contract.
 *  Never exposes credentials, headers, Provider objects, or internal runtime
 *  state — only configured/missing availability. */

export interface ModelCatalogOptions {
  modelRuntime: ModelRuntime;
}

export async function buildBackendModelCatalog(
  opts: ModelCatalogOptions,
): Promise<BackendModelCatalog> {
  const catalog = await opts.modelRuntime.getCatalog();
  const models: BackendModel[] = catalog.models.map((entry) => ({
    id: `${entry.providerId}/${entry.modelId}`,
    displayName: entry.displayName,
    reasoning: entry.reasoning,
    inputModalities: entry.inputModalities,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    available: entry.available,
    cost: entry.cost,
  }));
  return { backendKind: "oma", models };
}

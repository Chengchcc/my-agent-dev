import { Elysia } from "elysia";

/** Web-facing model DTO. Mirrors apps/web/src/lib/api.ts listModels type —
 *  keep both in sync (e2e-contract-rules). */
export interface WebModel {
  id: string;
  name: string;
  available?: boolean;
  reasoning: boolean;
  input: readonly string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** Producing backend kind (oma / claude_code / pi / omp). The
   *  same provider/model id may exist under several kinds — the UI groups
   *  by kind first (D3). */
  backendKind: string;
}

export interface ModelsCatalog {
  list(): Promise<WebModel[]>;
}

/** Group a flat model list into provider buckets. The catalog's canonical
 *  ids are `<provider>/<model>`; split on the first slash. */
export function groupByProvider(models: WebModel[]): Array<{
  id: string;
  name: string;
  models: WebModel[];
}> {
  const byProvider = new Map<string, WebModel[]>();
  for (const m of models) {
    const slash = m.id.indexOf("/");
    const provider = slash > 0 ? m.id.slice(0, slash) : "unknown";
    const list = byProvider.get(provider) ?? [];
    list.push({ ...m, id: slash > 0 ? m.id.slice(slash + 1) : m.id });
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => ({ id, name: id, models }));
}

export function modelRoutes(catalog: ModelsCatalog) {
  return new Elysia().get("/api/models", async () => {
    const models = await catalog.list();
    return { providers: groupByProvider(models) };
  });
}

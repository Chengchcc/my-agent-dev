import type { Message } from "@my-agent-team/message";
import type {
  CatalogRefreshResult,
  CredentialStore,
  ModelCost,
  ModelRuntime,
  ModelRuntimeEntry,
  Provider,
} from "./types.js";

export interface ModelRuntimeOptions {
  credentialStore?: CredentialStore;
}

export function createModelRuntime(opts: ModelRuntimeOptions = {}): ModelRuntime {
  const store = opts.credentialStore ?? null;
  const providers = new Map<string, Provider>();
  let cache: CatalogRefreshResult | null = null;

  function buildEntry(
    p: Provider,
    m: {
      id: string;
      name: string;
      reasoning: boolean;
      input: readonly string[];
      contextWindow: number;
      maxTokens: number;
      cost: ModelCost;
    },
  ): ModelRuntimeEntry {
    return {
      providerId: p.id,
      modelId: m.id,
      displayName: m.name,
      reasoning: m.reasoning,
      inputModalities: m.input,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxTokens,
      available: true,
      cost: m.cost,
    };
  }

  function buildCatalog(): CatalogRefreshResult {
    const models: ModelRuntimeEntry[] = [];
    for (const p of providers.values()) {
      for (const m of p.getModels()) {
        models.push(buildEntry(p, m));
      }
    }
    return { models, timestamp: Date.now() };
  }

  return {
    registerProvider(provider: Provider): void {
      if (providers.has(provider.id))
        throw new Error(`Provider "${provider.id}" already registered`);
      providers.set(provider.id, provider);
      cache = null;
    },
    setProvider(provider: Provider): void {
      providers.set(provider.id, provider);
      cache = null;
    },
    getProvider(id: string): Provider | undefined {
      return providers.get(id);
    },
    async resolveModel(providerId: string, modelId: string) {
      const provider = providers.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      const models = provider.getModels();
      const matched = models.find((m) => m.id === modelId);
      if (!matched) throw new Error(`Model "${modelId}" not found`);
      const credential = store ? ((await store.resolve(providerId)) ?? {}) : {};
      return { model: buildEntry(provider, matched), credential };
    },
    async getCatalog() {
      if (cache) return cache;
      return this.refreshCatalog();
    },
    async refreshCatalog() {
      cache = buildCatalog();
      return cache;
    },
    async *stream(providerId: string, modelId: string, messages: readonly Message[], opts) {
      const provider = providers.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      const models = provider.getModels();
      const matched = models.find((m) => m.id === modelId);
      if (!matched) throw new Error(`Model "${modelId}" not found`);
      // Credential resolved per request; provider never caches it.
      const credential = store ? ((await store.resolve(providerId)) ?? {}) : {};
      yield* provider.stream(matched, messages, {
        apiKey: credential.apiKey,
        baseUrl: credential.baseUrl,
        headers: credential.headers,
        ...opts,
      });
    },
  };
}

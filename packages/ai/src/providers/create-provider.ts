import { getApiImplementation } from "../api-registry.js";
import { type Model, normalizeProviderError, type Provider, type ProviderAuth } from "../types.js";
import { fetchSSE } from "./shared-sse.js";

export interface CreateProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}

/** Unified provider factory (DIP): depends on ApiImplementation interface +
 *  StreamTransport abstraction. Dispatches by model.api — no switch, no
 *  concrete API module imports. Adding a new API never touches this file. */
export function createProvider(config: CreateProviderConfig): Provider {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    getModels: () => config.models,
    async *stream(model, messages, opts) {
      const impl = getApiImplementation(model.api);
      const { url, headers: apiHeaders, body } = impl.buildRequest(model, messages, opts);

      const apiKey = opts?.apiKey ?? config.auth.apiKey ?? "";
      const baseUrl = opts?.baseUrl ?? config.baseUrl;

      // Merge: API-specific headers (auth scheme, version) ← provider defaults ← per-request overrides.
      const headers: Record<string, string> = {
        ...apiHeaders,
        ...(config.auth.headers ?? {}),
        ...(opts?.headers ?? {}),
      };
      // Fill apiKey into the API's auth header template if it has a placeholder.
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string" && v.includes("{apiKey}"))
          headers[k] = v.replaceAll("{apiKey}", apiKey);
      }
      // Secrets redaction covers ALL header sources actually merged into
      // the request — not just one set — so error echoes can't leak.
      const secrets = [apiKey, ...Object.values(headers)].filter(Boolean);

      const convertChunk = impl.createChunkConverter();
      try {
        for await (const raw of fetchSSE({
          url: baseUrl + url,
          headers,
          body: JSON.stringify(body),
          signal: opts?.signal,
        })) {
          for (const chunk of convertChunk(raw)) yield chunk;
        }
      } catch (err) {
        throw normalizeProviderError(err, secrets);
      }
    },
  };
}

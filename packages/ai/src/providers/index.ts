import { BUILTIN_CATALOG, buildAllModels } from "../model-catalog.js";
import type { Model, Provider, ProviderAuth } from "../types.js";
import { createProvider } from "./create-provider.js";

/** Provider factories that read from the catalog and resolve credentials.
 *  Callers should migrate to createProvider() for custom providers. */

function providerFromCatalog(providerId: string, auth: ProviderAuth = {}): Provider | undefined {
  const catalog = buildAllModels(BUILTIN_CATALOG);
  const entry = catalog[providerId];
  if (!entry) return undefined;
  const apiKey = auth.apiKey ?? process.env[entry.spec.apiKeyEnv];
  if (!apiKey) return undefined;
  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl: auth.baseUrl ?? entry.spec.baseUrl,
    auth: { apiKey, headers: auth.headers },
    models: entry.models,
  });
}

export function anthropicProvider(auth: ProviderAuth = {}): Provider | undefined {
  return providerFromCatalog("anthropic", auth);
}

export function deepseekProvider(auth: ProviderAuth = {}): Provider | undefined {
  return providerFromCatalog("deepseek", auth);
}

export function createOpenAICompatProvider(config: {
  id: string;
  name?: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}): Provider {
  return customProvider(config);
}

export function customProvider(config: {
  id: string;
  name?: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}): Provider {
  return createProvider({
    id: config.id,
    name: config.name ?? config.id,
    baseUrl: config.baseUrl,
    auth: config.auth,
    models: config.models,
  });
}

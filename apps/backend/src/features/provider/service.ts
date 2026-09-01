import { ValidationError } from "../../infra/domain-errors.js";
import type { SettingsService } from "../settings/index.js";
import type { ProviderDefinition, ProviderInfo, StoredProviderConfig } from "./domain.js";

export const KNOWN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  { id: "openai", name: "OpenAI", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "groq", name: "Groq", apiKeyEnv: "GROQ_API_KEY" },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY" },
];

export interface ProviderService {
  list(): ProviderInfo[];
  set(id: string, input: { apiKey?: string; baseUrl?: string }): ProviderInfo;
  clear(id: string): void;
  getProviderEnv(): Record<string, string | undefined>;
}

const storageKey = (id: string) => `provider.${id}`;

function definitionOf(id: string): ProviderDefinition {
  const def = KNOWN_PROVIDERS.find((d) => d.id === id);
  if (!def) throw new ValidationError(`Unknown provider: ${id}`);
  return def;
}

export function createProviderService(settingsSvc: SettingsService): ProviderService {
  function stored(id: string): StoredProviderConfig {
    return settingsSvc.get<StoredProviderConfig>(storageKey(id)) ?? {};
  }

  function configured(def: ProviderDefinition): boolean {
    const s = stored(def.id);
    return Boolean(s.apiKey || process.env[def.apiKeyEnv]);
  }

  return {
    list() {
      return KNOWN_PROVIDERS.map((d) => ({
        id: d.id,
        name: d.name,
        apiKeyEnv: d.apiKeyEnv,
        configured: configured(d),
      }));
    },

    set(id, input) {
      const def = definitionOf(id);
      const current = stored(id);
      const next: StoredProviderConfig = {
        ...current,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      };
      if (!next.apiKey && !next.baseUrl) {
        throw new ValidationError(`Provider ${id} requires an apiKey or baseUrl`);
      }
      settingsSvc.set(storageKey(id), next);
      return {
        id: def.id,
        name: def.name,
        apiKeyEnv: def.apiKeyEnv,
        configured: configured(def),
      };
    },

    clear(id) {
      definitionOf(id);
      settingsSvc.set<StoredProviderConfig>(storageKey(id), {});
    },

    getProviderEnv() {
      const env: Record<string, string | undefined> = {};
      for (const def of KNOWN_PROVIDERS) {
        const s = stored(def.id);
        if (s.apiKey) env[def.apiKeyEnv] = s.apiKey;
        if (s.baseUrl && def.baseUrlEnv) env[def.baseUrlEnv] = s.baseUrl;
      }
      return env;
    },
  };
}

export interface ProviderDefinition {
  id: string;
  name: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
}

export interface StoredProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
}

/** Stable reference to a model within a specific Agent Backend. */
export interface BackendModelRef {
  readonly backendKind: string;
  readonly modelId: string;
}

/** Backend-exposed model metadata. Aggregated by Product Backend across backends. */
export interface BackendModel {
  readonly id: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly inputModalities: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly available: boolean;
}

/** A backend's model listing. ModelRef must match the catalog's backendKind. */
export interface BackendModelCatalog {
  readonly backendKind: string;
  readonly models: readonly BackendModel[];
}

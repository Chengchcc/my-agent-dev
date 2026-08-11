/** Stable reference to a model within a specific Agent Backend kind. `K`
 *  constrains the ref to the Backend's own kind so a Backend of kind "fake"
 *  cannot receive a "claude-code" model ref. */
export interface BackendModelRef<K extends string = string> {
  readonly backendKind: K;
  readonly modelId: string;
  /** Thinking-mode effort (Anthropic-format `reasoning` param): none/low/
   *  high/max. Undefined = provider default. */
  readonly reasoningEffort?: "none" | "low" | "high" | "max";
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

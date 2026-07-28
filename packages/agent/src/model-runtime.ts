import type { ChatModel } from "@my-agent-team/core";

/** Stable model reference string, e.g. "anthropic/claude-sonnet-4-6". */
export type ModelRef = string;

/** Model resolved by a ModelRuntime — ready to pass to AgentConfig. */
export interface ResolvedModel {
  id: string;
  provider: string;
  name: string;
  chatModel: ChatModel;
}

/**
 * Abstract port for model resolution.
 * Backend implements this with @my-agent-team/ai.
 */
export interface ModelRuntime {
  resolve(ref: ModelRef): ResolvedModel | Promise<ResolvedModel>;
}

/** Resolve a ChatModel or ModelRef into a ResolvedModel. */
export async function resolveModel(
  input: ChatModel | ModelRef,
  runtime?: ModelRuntime,
): Promise<ResolvedModel> {
  if (typeof input !== "string")
    return { id: "custom", provider: "custom", name: "custom", chatModel: input };
  if (!runtime) throw new Error(`Model reference "${input}" requires a ModelRuntime`);
  return runtime.resolve(input);
}

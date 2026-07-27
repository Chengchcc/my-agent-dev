import type { ModelRuntime, ModelRef, ResolvedModel } from "@my-agent-team/agent";

/**
 * Adapt @my-agent-team/ai's ModelRegistry + ProviderAuth into a ModelRuntime.
 * Import `resolveModel` and `ModelRegistry` from @my-agent-team/ai at call site.
 */
export function createModelRuntime(
  resolveModel: (ref: string, registry: unknown) => { provider: string; id: string; name: string },
  registry: unknown,
  createModel: (model: { provider: string; id: string }, auth: unknown) => unknown,
  auth: unknown,
): ModelRuntime {
  return {
    resolve(ref: ModelRef): ResolvedModel {
      const m = resolveModel(ref, registry);
      return {
        id: `${m.provider}/${m.id}`,
        provider: m.provider,
        name: m.name,
        chatModel: createModel(m, auth) as ResolvedModel["chatModel"],
      };
    },
  };
}

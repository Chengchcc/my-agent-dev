// P10: Re-export framework's branded ContextKey and ContextStore.
// Plugin keys are framework.defineContext<T>() — must use the SAME
// branded ContextKey<T> so generic types (string, PetBark, etc.) survive.
// P11 will move the implementation into packages/agent.
export type {
  ContextKey,
  ContextStore as RunState,
} from "@my-agent-team/framework";

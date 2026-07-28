// P10: public type names. Implementation is framework's until P11.
// AgentConfig.metaContext uses RunState; plugin ContextKeys are branded.
// The metaContext callback at the backend layer uses framework.ContextStore
// directly because branded ContextKey<T> inference requires same-module types.
export interface ContextKey<_T> {
  readonly name: string;
}

export interface RunState {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}

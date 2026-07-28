const CONTEXT_KEY_BRAND: unique symbol = Symbol("context-key");

/** 带 T 品牌的键，T 只在编译期存在（phantom）。 */
export interface ContextKey<T> {
  readonly name: string;
  readonly [CONTEXT_KEY_BRAND]?: T;
  /** 从 store 或 HookContext 读本键的值，缺席返回 undefined。 */
  get(source: ContextStore | { context: ContextStore }): T | undefined;
}

/** 不透明的 per-run 数据袋。引擎持有它但从不读内容。 */
export interface ContextStore {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}

/** 声明一个 typed context key，name 作为内部 map 键。 */
export function defineContext<T>(name: string): ContextKey<T> {
  const key: ContextKey<T> = {
    name,
    get(source) {
      const store = "context" in source ? source.context : source;
      return store.get(key);
    },
  };
  return key;
}

/** 默认 in-memory 实现（name-keyed Map）。 */
export function createContextStore(): ContextStore {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: ContextKey<T>) {
      return map.get(key.name) as T | undefined;
    },
    set<T>(key: ContextKey<T>, value: T) {
      map.set(key.name, value);
    },
    has(key) {
      return map.has(key.name);
    },
    delete(key) {
      map.delete(key.name);
    },
    clear() {
      map.clear();
    },
  };
}

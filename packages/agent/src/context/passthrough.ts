import type { ContextManager } from "./context-manager.js";

export function passthroughContextManager(): ContextManager {
  return {
    async shape(_ctx, messages) {
      return [...messages];
    },
  };
}

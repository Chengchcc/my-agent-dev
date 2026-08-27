import type { WorkflowNode } from "./types.js";

/** Per-node-instance context. */
export interface NodeContext {
  executionId: string;
  nodeId: string;
  workflowId: string;
  repo?: string;
}

/** Execution-scoped store API injected into script nodes.
 *  ponytail: get 同步而 set/delete 异步，v1 接受；若脚本重度读 store 再对称化。
 *  ponytail: 契约无 timeout/cancel 通道，超时靠 shell race；需要可取消长任务时再加。 */
export interface StoreApi {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Capabilities injected into a script node's default export. */
export interface ScriptContext {
  input: Record<string, unknown>;
  store: StoreApi;
  context: NodeContext;
  log(event: string, data?: Record<string, unknown>): void;
}

/** Result of running a node. */
export interface NodeRunResult {
  output?: Record<string, unknown>;
}

/** Contract implemented by the backend I/O shell (Plan 2). */
export interface NodeRunner {
  run(
    node: WorkflowNode,
    deps: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  ): Promise<NodeRunResult>;
}

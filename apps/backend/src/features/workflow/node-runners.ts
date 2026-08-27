import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  NodeContext,
  NodeRunResult,
  ScriptContext,
  StoreApi,
  WorkflowNode,
} from "@chengchenccc/workflow";

export interface NodeRunnerDeps {
  dataDir: string;
  /** Emit structured script logs into the execution event stream. */
  onLog?: (executionId: string, data: Record<string, unknown>) => void;
}

export function createNodeRunners(deps: NodeRunnerDeps) {
  return {
    script: {
      async run(
        node: WorkflowNode,
        ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
      ): Promise<NodeRunResult> {
        if (node.type !== "script") throw new Error(`not a script node: ${node.type}`);
        const log = (event: string, data?: Record<string, unknown>) =>
          deps.onLog?.(ctx.context.executionId, { event, data });
        if (node.timeoutMs !== undefined) {
          return await runWithTimeout(node.code, node.timeoutMs, ctx, deps.dataDir, log);
        }
        return await runScript(node.code, ctx, deps.dataDir, log);
      },
    },
  };
}

async function runScript(
  code: string,
  ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  dataDir: string,
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<NodeRunResult> {
  mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, `${ctx.context.executionId}-${ctx.context.nodeId}.ts`);
  writeFileSync(file, code);
  try {
    // ponytail: script code comes from DSL at runtime — static import cannot
    // see a file that only exists after the workflow starts, so a dynamic
    // import of the temp artifact is the only way to execute it.
    const mod = await import(`${file}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const fn = mod.default as (c: ScriptContext) => unknown;
    const scriptCtx: ScriptContext = { ...ctx, log };
    const out = (await fn(scriptCtx)) ?? {};
    return { output: out as Record<string, unknown> };
  } finally {
    rmSync(file, { force: true });
  }
}

function runWithTimeout(
  code: string,
  timeoutMs: number,
  ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  dataDir: string,
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<NodeRunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<NodeRunResult>();
  const timer = setTimeout(
    () => reject(new Error(`script timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  runScript(code, ctx, dataDir, log).then(
    (result) => {
      clearTimeout(timer);
      resolve(result);
    },
    (err) => {
      clearTimeout(timer);
      reject(err);
    },
  );
  return promise;
}

export type NodeRunners = ReturnType<typeof createNodeRunners>;

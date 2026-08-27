import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  FormField,
  NodeContext,
  NodeRunResult,
  ScriptContext,
  StoreApi,
  WorkflowNode,
} from "@chengchenccc/workflow";

export interface NodeRunnerDeps {
  dataDir: string;
  agentRunService?: {
    createPendingAction(
      runId: string,
      action: { kind: string; payload: Readonly<Record<string, unknown>> },
    ): Promise<{
      actionId: string;
      runId: string;
      kind: string;
      payload: Record<string, unknown>;
      status: string;
    }>;
  };
}

export function createNodeRunners(deps: NodeRunnerDeps) {
  return {
    script: {
      async run(
        node: WorkflowNode,
        ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
      ): Promise<NodeRunResult> {
        if (node.type !== "script") throw new Error(`not a script node: ${node.type}`);
        if (node.timeoutMs !== undefined) {
          return await runWithTimeout(node.code, node.timeoutMs, ctx, deps.dataDir);
        }
        return await runScript(node.code, ctx, deps.dataDir);
      },
    },
    human: {
      async run(
        node: WorkflowNode,
        ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
      ): Promise<NodeRunResult> {
        if (node.type !== "human") throw new Error(`not a human node: ${node.type}`);
        if (!deps.agentRunService) throw new Error("human runner requires agentRunService");
        const question = (ctx.input.question as string | undefined) ?? node.question ?? "";
        const form = (ctx.input.form as Record<string, FormField> | undefined) ?? node.form ?? {};
        await deps.agentRunService.createPendingAction(ctx.context.executionId, {
          kind: "human_task_requested",
          payload: { executionId: ctx.context.executionId, nodeId: node.id, question, form },
        });
        return { output: { question, form } };
      },
    },
  };
}

async function runScript(
  code: string,
  ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  dataDir: string,
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
    const scriptCtx: ScriptContext = { ...ctx, log: () => {} };
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
): Promise<NodeRunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<NodeRunResult>();
  const timer = setTimeout(
    () => reject(new Error(`script timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  runScript(code, ctx, dataDir).then(
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

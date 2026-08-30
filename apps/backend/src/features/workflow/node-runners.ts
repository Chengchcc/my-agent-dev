import { runInSandbox } from "@chengchenccc/sandbox";
import type { NodeContext, NodeRunResult, StoreApi, WorkflowNode } from "@chengchenccc/workflow";

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
        // Scripts run inside the process sandbox package (spawned bun
        // subprocess, own cwd, minimal env, hard timeout). Host objects
        // (store, event bus) deliberately stay out of the sandbox — the
        // script contract is (input) => output over JSON stdio.
        const result = await runInSandbox({
          code: node.code,
          input: ctx.input,
          timeoutMs: node.timeoutMs ?? 60_000,
        });
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim().split("\n").slice(-3).join(" | ");
          throw new Error(`script failed (exit ${result.exitCode}): ${detail || "unknown error"}`);
        }
        if (result.stdout.trim().length > 0) log("script_stdout", { text: result.stdout.trim() });
        return { output: result.output ?? {} };
      },
    },
  };
}

export type NodeRunners = ReturnType<typeof createNodeRunners>;

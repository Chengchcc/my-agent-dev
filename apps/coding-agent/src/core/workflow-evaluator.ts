import vm from "node:vm";

export interface WorkflowPrimitives {
  readonly agent: (
    prompt: string,
    opts?: { schema?: Readonly<Record<string, unknown>>; label?: string },
  ) => Promise<unknown>;
  readonly pipeline: (
    items: readonly unknown[],
    fn: (item: unknown) => Promise<unknown>,
    opts?: { concurrency?: number },
  ) => Promise<readonly unknown[]>;
}

export interface EvaluateResult {
  readonly value: unknown;
}

/** Sandboxed script evaluation: ONLY agent/pipeline/args are injected.
 *  require/process/fs/fetch do not exist inside the script. The vm timeout
 *  covers synchronous infinite loops; the caller races the returned promise
 *  against the script budget for async stalls. */
export async function evaluateWorkflowScript(input: {
  readonly script: string;
  readonly args?: unknown;
  readonly primitives: WorkflowPrimitives;
  readonly timeoutMs?: number;
}): Promise<EvaluateResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const { agent, pipeline } = input.primitives;
  // codeGeneration off kills the constructor.constructor escape: no dynamic
  // code can be minted from the sandbox (the model's bash tool is already
  // workspace-scoped; this closes the vm's host-Function bridge).
  const context = vm.createContext(
    { agent, pipeline, args: input.args },
    { name: "workflow-script", codeGeneration: { strings: false, wasm: false } },
  );
  const wrapped = `(async () => { ${input.script} })()`;
  const promise = vm.runInContext(wrapped, context, { timeout: timeoutMs }) as Promise<unknown>;
  const timer = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error("workflow script timed out")), timeoutMs);
    void promise.finally(() => clearTimeout(id)).catch(() => {});
  });
  const value = await Promise.race([promise, timer]);
  return { value };
}

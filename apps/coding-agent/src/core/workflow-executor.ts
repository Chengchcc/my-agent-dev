import {
  type CodingAgentLoopEvent,
  type CodingAgentSession,
  type ContextBudget,
  type ContextSummarizer,
  createCodingAgentSession,
  createInMemorySessionStore,
  type PluginTool,
} from "@my-agent-team/agent";
import type { Usage } from "@my-agent-team/agent-backend";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

export interface WorkflowAgentSpec {
  readonly prompt: string;
  readonly label?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface WorkflowAgentResult {
  readonly label: string;
  readonly text: string;
  readonly output?: unknown;
  readonly ok: boolean;
  readonly error?: string;
  readonly usage?: Usage;
}

export interface WorkflowRunResult {
  readonly items: readonly WorkflowAgentResult[];
  readonly totalTokens: number;
  readonly ok: boolean;
}

/** Same shape as the session's modelStream option: the subagent session calls
 *  it with its own messages/signal/tools. */
export type SubagentModelStream = (
  messages: readonly Message[],
  signal?: AbortSignal,
  tools?: readonly PluginTool[],
) => AsyncIterable<AIMessageChunk>;

export interface WorkflowExecutorOptions {
  /** Build the subagent model stream (same model + reasoning as the run). */
  readonly makeSubagentStream: (sessionId: string) => SubagentModelStream;
  readonly modelId: string;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget;
  /** File tools only (no workflow/product tools - recursion + clobber guards). */
  readonly tools: readonly PluginTool[];
  readonly workspaceRoot: string;
  readonly workspaceAccess: "read_only" | "read_write";
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  readonly emit: (event: CodingAgentLoopEvent) => void;
  /** Optional product budget gate: consulted BEFORE each spawn. */
  readonly budgetGate?: () => { allowed: boolean; reason?: string };
}

export interface WorkflowExecutor {
  runSubagent(
    input: { workflowId: string; agentId: string } & WorkflowAgentSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowAgentResult>;
  runWorkflow(input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }): Promise<WorkflowRunResult>;
}

const SUBAGENT_SYSTEM_PROMPT =
  "You are a subagent of a coding agent run. Complete the given task in as few " +
  "steps as possible. Use tools only to gather what you need. When you have the " +
  "answer, write it as your FINAL message and STOP - do not call more tools, do " +
  "not double-check with extra reads. Return only the result text (or JSON when " +
  "a schema is requested).";

export function createWorkflowExecutor(opts: WorkflowExecutorOptions): WorkflowExecutor {
  let totalSpawned = 0;
  let current = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (current < opts.maxConcurrent) {
      current++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else current--;
  }

  class WorkflowGateError extends Error {}

  function gate(): void {
    if (totalSpawned >= opts.maxTotal) {
      throw new WorkflowGateError(`workflow exceeds the ${opts.maxTotal}-agent cap`);
    }
    if (opts.budgetGate) {
      const decision = opts.budgetGate();
      if (!decision.allowed) {
        throw new WorkflowGateError(decision.reason ?? "workflow budget exhausted");
      }
    }
    totalSpawned++;
  }

  async function runSubagent(
    input: { workflowId: string; agentId: string } & WorkflowAgentSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowAgentResult> {
    await acquire();
    // gate() may throw (cap/budget): it runs inside the try so the acquired
    // concurrency slot is ALWAYS released - a leak here would deadlock every
    // later acquire once all slots are gone.
    try {
      gate();
      const label = input.label ?? input.agentId;
      const sessionId = `wf:${input.workflowId}:${input.agentId}`;
      opts.emit({
        type: "workflow_agent_started",
        workflowId: input.workflowId,
        agentId: input.agentId,
        label,
      });
      const store = createInMemorySessionStore();
      // The loop opens the session record on startLoop: seed it first
      // (same contract as the run runtime's create-runtime.ts).
      await store.create({
        sessionId,
        backendKind: "coding_agent",
        workspaceRoot: opts.workspaceRoot,
        leafEntryId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const session = createCodingAgentSession({
        sessionId,
        store,
        plugins: [{ name: "subagent-tools", tools: opts.tools }],
        maxSteps: 24,
        maxForceContinues: 2,
        modelStream: opts.makeSubagentStream(sessionId),
        summarize: opts.summarize,
        contextBudget: opts.contextBudget,
      });
      const onAbort = (): void => session.stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      let result: Awaited<ReturnType<CodingAgentSession["startLoop"]>>;
      try {
        result = await session.startLoop({
          history: [],
          input: {
            inputId: input.agentId,
            message: { role: "user", text: input.prompt },
          },
          run: {
            runId: sessionId,
            model: { backendKind: "coding_agent", modelId: opts.modelId },
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            configRevision: 0,
          },
          workspace: { root: opts.workspaceRoot, access: opts.workspaceAccess },
          metadata: { conversationId: "", agentMemberId: "", branchId: "" },
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      void store.close().catch(() => {});
      const lastAssistant = [...(result.messages ?? [])].reverse().find((m) => m.role === "assistant");
      const text = (lastAssistant?.text ?? "").trim();
      let output: unknown;
      let parseError: string | undefined;
      if (input.schema && text) {
        try {
          output = JSON.parse(text);
        } catch {
          parseError = `schema output is not valid JSON: ${text.slice(0, 120)}`;
        }
      }
      const agentResult: WorkflowAgentResult = {
        label,
        text,
        ok: result.status === "completed" && !parseError,
        ...(output !== undefined ? { output } : {}),
        ...(parseError ? { error: parseError } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
      opts.emit({
        type: "workflow_agent_completed",
        workflowId: input.workflowId,
        agentId: input.agentId,
        label,
        ok: agentResult.ok,
        ...(agentResult.error ? { error: agentResult.error } : {}),
        ...(agentResult.usage ? { usage: agentResult.usage } : {}),
      });
      return agentResult;
    } catch (err) {
      // Gate failures (cap/budget) are WORKFLOW-level: propagate so the
      // whole fan-out rejects instead of degrading to a failed agent row.
      if (err instanceof WorkflowGateError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const label = input.label ?? input.agentId;
      opts.emit({
        type: "workflow_agent_completed",
        workflowId: input.workflowId,
        agentId: input.agentId,
        label,
        ok: false,
        error: message,
      });
      return { label, text: "", ok: false, error: message };
    } finally {
      release();
    }
  }

  async function runWorkflow(input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }): Promise<WorkflowRunResult> {
    opts.emit({
      type: "workflow_started",
      workflowId: input.workflowId,
      label: input.label,
      agentCount: input.items.length,
    });
    const results = await Promise.all(
      input.items.map((item, i) =>
        runSubagent({ workflowId: input.workflowId, agentId: `a${i}`, ...item }, input.signal),
      ),
    );
    const totalTokens = results.reduce(
      (acc, r) =>
        acc +
        (r.usage?.inputTokens ?? 0) +
        (r.usage?.outputTokens ?? 0) +
        (r.usage?.cacheReadTokens ?? 0) +
        (r.usage?.cacheWriteTokens ?? 0),
      0,
    );
    const ok = results.every((r) => r.ok);
    opts.emit({
      type: "workflow_completed",
      workflowId: input.workflowId,
      ok,
      agentCount: input.items.length,
      totalTokens,
    });
    return { items: results, totalTokens, ok };
  }

  return { runSubagent, runWorkflow };
}

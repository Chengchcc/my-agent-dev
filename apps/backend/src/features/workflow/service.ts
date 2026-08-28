import {
  type CompletionRecord,
  computeNext,
  type EngineState,
  type NodeRunner,
  type NodeRunResult,
  routeOutgoing,
  type StoreApi,
  validateBySchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@chengchenccc/workflow";
import { HttpError } from "../../infra/errors.js";
import type { WorkflowExecutionRow, WorkflowNodeRunRow } from "./domain.js";
import type { ExecutionEventBus, WorkflowEvent } from "./event-bus.js";
import type { WorkflowExecutionPort } from "./ports.js";

export interface AgentRunnerDeps {
  agentRunService?: {
    enqueueAndAcquire(
      input: Record<string, unknown>,
    ): Promise<{ acquired: boolean; run?: { runId: string } }>;
    getRun(runId: string): Promise<{ status?: string; terminalResult?: unknown } | null>;
  };
  agentRunExecution?: {
    dispatch(runId: string): Promise<void>;
    subscribe(
      runId: string,
      signal?: AbortSignal,
    ): AsyncIterable<{ type: string; status?: string }>;
  };
  convPort?: {
    getConversation(id: string): unknown;
    createConversation(input: {
      conversationId: string;
      agentId: string;
      origin: string;
      createdAt: number;
    }): unknown;
  };
  resolveDefaultModel?: (agentId: string) => Promise<unknown>;
  resolveRepoWorkspace?: (
    repo: string,
    agentId: string,
  ) => Promise<Record<string, unknown> | undefined>;
}

export interface WorkflowExecutionServiceDeps extends AgentRunnerDeps {
  port: WorkflowExecutionPort;
  eventBus: ExecutionEventBus;
  idGen: () => string;
  nodeRunners: Partial<Record<"script" | "human", NodeRunner>>;
}

export interface WorkflowExecutionService {
  runToCompletion(
    executionId: string,
    input: { workflowId: string; definition: WorkflowDefinition; input: Record<string, unknown> },
  ): Promise<WorkflowExecutionRow>;
  startExecution(input: {
    workflowId: string;
    definition: WorkflowDefinition;
    input: Record<string, unknown>;
  }): Promise<WorkflowExecutionRow>;
  resolveHumanTask(
    executionId: string,
    nodeId: string,
    answer: Record<string, unknown>,
  ): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  listExecutions(workflowId?: string): Promise<WorkflowExecutionRow[]>;
  listExecutionEvents(
    executionId: string,
  ): Promise<Array<{ seq: number; executionId: string; event: string; data: unknown; ts: number }>>;
  subscribeEvents(executionId: string, signal?: AbortSignal): Promise<AsyncIterable<WorkflowEvent>>;
  recover(): Promise<void>;
  dispose(): Promise<void>;
}

function exitStatus(exit: string): "success" | "failure" | "custom" {
  if (exit === "failure") return "failure";
  if (exit === "success") return "success";
  return "custom";
}

function extractFinalText(outcome: unknown): string {
  const o = outcome as { messages?: Array<{ role?: string; text?: string }> } | null;
  const last = o?.messages
    ?.slice()
    .reverse()
    .find((m) => m.role === "assistant");
  return last?.text ?? "";
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function extractOutput(
  outcome: unknown,
  outputHint?: Record<string, string>,
): Record<string, unknown> {
  const text = extractFinalText(outcome);
  if (!text) return outputHint ? {} : { text: "" };
  const parsed = tryParseJsonObject(text);
  if (parsed) return parsed;
  if (outputHint)
    throw new Error("agent node output must be a JSON object matching declared output hints");
  return { text };
}

function buildAgentPrompt(
  node: WorkflowNode,
  input: Record<string, unknown>,
  outputHint?: Record<string, string>,
): string {
  const base = node.type === "agent" ? (node.prompt ?? "") : "";
  const suffix =
    outputHint && Object.keys(outputHint).length > 0
      ? `\n\nYour final answer MUST be a JSON object with fields: ${Object.keys(outputHint).join(", ")}\nOptional: nextNode (string). Do not output anything else.`
      : "";
  return `${base}\n\nInput: ${JSON.stringify(input)}${suffix}`;
}

export function createWorkflowExecutionService(
  deps: WorkflowExecutionServiceDeps,
): WorkflowExecutionService {
  const completions = new Map<string, CompletionRecord[]>();

  function emit(executionId: string, event: string, data: unknown) {
    deps.eventBus.emit({ executionId, event, ts: Date.now(), data });
    // ponytail: event persistence failure must not block drive; the event bus
    // copy still fires, the durable trace just misses one row.
    deps.port.appendExecutionEvent({ executionId, event, data, ts: Date.now() }).catch(() => {});
  }

  async function storeApiOf(
    executionId: string,
    getStore: () => Record<string, unknown>,
  ): Promise<StoreApi> {
    return {
      get: (key) => getStore()[key],
      set: async (key, value) => {
        const store = getStore();
        store[key] = value;
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, value });
      },
      delete: async (key) => {
        const store = getStore();
        delete store[key];
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, deleted: true });
      },
    };
  }

  async function runNodeWithRetry(
    node: WorkflowNode,
    run: (n: WorkflowNode) => Promise<NodeRunResult>,
  ): Promise<NodeRunResult> {
    const retry = node.retry ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        return await run(node);
      } catch (err) {
        lastError = err;
        if (attempt === retry) throw err;
      }
    }
    throw lastError;
  }

  async function runWorkflowNode(
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    execution: WorkflowExecutionRow,
  ): Promise<Record<string, unknown>> {
    const runner = deps.nodeRunners.script;
    if (!runner) throw new Error(`no runner for node type ${node.type}`);
    const storeApi = await storeApiOf(execution.executionId, () => execution.store);
    const result = await runNodeWithRetry(node, (n) =>
      runner.run(n, {
        input: ready.input,
        store: storeApi,
        context: {
          executionId: execution.executionId,
          nodeId: n.id,
          workflowId: execution.workflowId,
          repo: "repo" in n ? n.repo : undefined,
        },
      }),
    );
    return result.output ?? {};
  }

  async function runAgentNode(
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    execution: WorkflowExecutionRow,
  ): Promise<NodeRunResult> {
    if (node.type !== "agent") throw new Error(`not agent: ${node.type}`);
    if (
      !deps.agentRunService ||
      !deps.agentRunExecution ||
      !deps.convPort ||
      !deps.resolveDefaultModel
    ) {
      throw new Error(
        "agent runner requires agentRunService/agentRunExecution/convPort/resolveDefaultModel",
      );
    }
    const agentId = node.agentId ?? "";
    if (!agentId) throw new Error("agent node requires agentId");
    const conversationId = `workflow:${execution.executionId}:${node.id}`;
    const prompt = buildAgentPrompt(node, ready.input, node.output);

    if (!deps.convPort.getConversation(conversationId)) {
      try {
        deps.convPort.createConversation({
          conversationId,
          agentId,
          origin: "workflow",
          createdAt: Date.now(),
        });
      } catch {
        /* concurrent */
      }
    }

    const defaultModel = await deps.resolveDefaultModel(agentId);
    const workspace = node.repo ? await deps.resolveRepoWorkspace?.(node.repo, agentId) : undefined;
    const input: Record<string, unknown> = {
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: prompt },
      defaultModel,
      configRevision: 1,
      idempotencyKey: `wf:${execution.executionId}:${node.id}`,
    };
    if (workspace) input.workspace = workspace;

    const acquired = await deps.agentRunService.enqueueAndAcquire(input);
    const runId = acquired.run?.runId;
    if (!runId) throw new Error("agent run not acquired");

    emit(execution.executionId, "node_agent_started", { nodeId: node.id, runId });
    await deps.agentRunExecution.dispatch(runId);
    for await (const ev of deps.agentRunExecution.subscribe(runId)) {
      if (
        ev.type === "status" &&
        ["completed", "failed", "aborted", "commit_failed"].includes(ev.status ?? "")
      ) {
        const run = await deps.agentRunService.getRun(runId);
        if (run?.status !== "completed")
          throw new Error(`agent run ${runId} ended ${run?.status ?? "unknown"}`);
        const output = extractOutput(run.terminalResult, node.output);
        emit(execution.executionId, "node_agent_completed", { nodeId: node.id, runId });
        return { output };
      }
    }
    throw new Error(`agent run ${runId} subscribe returned without terminal`);
  }

  async function executeNode(
    execution: WorkflowExecutionRow,
    node: WorkflowNode,
    ready: { input: Record<string, unknown> },
    order: number,
  ): Promise<{ output: Record<string, unknown> } | null> {
    emit(execution.executionId, "node_started", { nodeId: node.id, order });
    const existing = (await deps.port.listNodeRuns(execution.executionId)).find(
      (r) => r.nodeId === node.id,
    );
    if (!existing) {
      await deps.port.appendNodeRun({
        executionId: execution.executionId,
        nodeId: node.id,
        status: node.type === "human" ? "waiting_human" : "running",
        order,
      });
    }

    const inputErrors = node.inputSchema ? validateBySchema(ready.input, node.inputSchema) : [];
    if (inputErrors.length > 0)
      throw new Error(`node ${node.id} input invalid: ${inputErrors.join("; ")}`);

    let output: Record<string, unknown>;
    if (node.type === "start") {
      output = { ...execution.input };
    } else if (node.type === "human") {
      const question = (ready.input.question as string | undefined) ?? node.question;
      const form = (ready.input.form as Record<string, unknown> | undefined) ?? node.form;
      await deps.port.createPendingHuman({
        executionId: execution.executionId,
        nodeId: node.id,
        question,
        form,
        status: "pending",
        createdAt: Date.now(),
      });
      await deps.port.updateExecution(execution.executionId, { status: "waiting_human" });
      emit(execution.executionId, "human_task_requested", { nodeId: node.id, question, form });
      return null;
    } else {
      try {
        output =
          node.type === "agent"
            ? ((await runAgentNode(node, ready, execution)).output ?? {})
            : await runWorkflowNode(node, ready, execution);
      } catch (err) {
        emit(execution.executionId, "node_failed", {
          nodeId: node.id,
          error: (err as Error).message,
        });
        throw err;
      }
    }

    const outputErrors = node.outputSchema ? validateBySchema(output, node.outputSchema) : [];
    if (outputErrors.length > 0)
      throw new Error(`node ${node.id} output invalid: ${outputErrors.join("; ")}`);
    return { output };
  }

  function recordCompletion(
    execution: WorkflowExecutionRow,
    node: WorkflowNode,
    output: Record<string, unknown>,
    order: number,
  ): CompletionRecord {
    const arr = completions.get(execution.executionId) ?? [];
    const routedTo = routeOutgoing(node.id, execution.definition, arr, execution.store, output);
    const record: CompletionRecord = { nodeId: node.id, output, order, routedTo };
    arr.push(record);
    completions.set(execution.executionId, arr);
    return record;
  }

  function rebuildCompletions(nodeRuns: WorkflowNodeRunRow[]): CompletionRecord[] {
    return nodeRuns
      .filter((r) => r.status === "completed")
      .map((r, i) => ({
        nodeId: r.nodeId,
        output: r.output ?? {},
        order: i,
        routedTo: r.routedTo ?? [],
      }));
  }

  async function drive(execution: WorkflowExecutionRow): Promise<void> {
    if (completions.get(execution.executionId) === undefined) {
      const nodeRuns = await deps.port.listNodeRuns(execution.executionId);
      completions.set(execution.executionId, rebuildCompletions(nodeRuns));
    }
    let order = completions.get(execution.executionId)!.length;
    for (;;) {
      const state: EngineState = {
        completions: completions.get(execution.executionId) ?? [],
        store: execution.store,
        trigger: execution.input,
      };
      const step = computeNext(execution.definition, state);
      if (step.kind === "terminal") {
        await deps.port.updateExecution(execution.executionId, {
          status: exitStatus(step.exit),
          exit: step.exit,
          terminalAt: Date.now(),
        });
        emit(execution.executionId, "execution_terminal", { exit: step.exit });
        return;
      }
      if (step.kind === "idle") throw new Error("stuck: no ready nodes and no terminal");
      let paused = false;
      for (const ready of step.ready) {
        const node = ready.node;
        const res = await executeNode(execution, node, ready, order++);
        if (res === null) {
          paused = true;
          break;
        }
        const record = recordCompletion(execution, node, res.output, order - 1);
        await deps.port.updateNodeRun(execution.executionId, node.id, {
          status: "completed",
          output: record.output,
          routedTo: record.routedTo,
          terminalAt: Date.now(),
        });
        emit(execution.executionId, "node_completed", {
          nodeId: node.id,
          output: record.output,
          routedTo: record.routedTo,
        });
        const fresh = await deps.port.getExecution(execution.executionId);
        if (fresh) execution.store = fresh.store;
      }
      if (paused) return;
    }
  }

  async function runWithCatch(executionId: string, execute: () => Promise<void>): Promise<void> {
    try {
      await execute();
    } catch (err) {
      await deps.port.updateExecution(executionId, {
        status: "failure",
        error: (err as Error).message,
        exit: "failure",
        terminalAt: Date.now(),
      });
      emit(executionId, "execution_terminal", { exit: "failure", error: (err as Error).message });
    }
  }

  return {
    async runToCompletion(executionId, input) {
      const row = await deps.port.createExecution({
        executionId,
        workflowId: input.workflowId,
        definition: input.definition,
        input: input.input,
        store: {},
        status: "running",
      });
      emit(executionId, "execution_started", {});
      await runWithCatch(executionId, () => drive(row));
      return (await deps.port.getExecution(executionId))!;
    },
    async startExecution(input) {
      const executionId = deps.idGen();
      const row = await deps.port.createExecution({
        executionId,
        workflowId: input.workflowId,
        definition: input.definition,
        input: input.input,
        store: {},
        status: "running",
      });
      emit(executionId, "execution_started", {});
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async resolveHumanTask(executionId, nodeId, answer) {
      const row = await deps.port.getExecution(executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      if (row.status !== "waiting_human")
        throw new HttpError("Execution is not waiting for human", 409);
      const pending = await deps.port.getPendingHuman(executionId, nodeId);
      if (!pending) throw new HttpError("Pending human task not found", 404);
      if (pending.status === "resolved") throw new HttpError("Human task already resolved", 409);

      const done = (await deps.port.listNodeRuns(executionId)).filter(
        (r) => r.status === "completed",
      );
      const arr = done.map((r, i) => ({
        nodeId: r.nodeId,
        output: r.output ?? {},
        order: i,
        routedTo: r.routedTo ?? [],
      }));
      const routedTo = routeOutgoing(nodeId, row.definition, arr, row.store, answer);
      await deps.port.markPendingHumanResolved(executionId, nodeId);
      await deps.port.updateNodeRun(executionId, nodeId, {
        status: "completed",
        output: answer,
        routedTo,
        terminalAt: Date.now(),
      });
      arr.push({ nodeId, output: answer, order: arr.length, routedTo });
      completions.set(executionId, arr);
      const fresh = await deps.port.getExecution(executionId);
      if (fresh) row.store = fresh.store;
      await deps.port.updateExecution(executionId, { status: "running" });
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async getExecution(id) {
      return deps.port.getExecution(id);
    },
    async listNodeRuns(id) {
      return deps.port.listNodeRuns(id);
    },
    async listExecutions(workflowId) {
      return deps.port.listExecutions(workflowId);
    },
    async listExecutionEvents(executionId) {
      return deps.port.listExecutionEvents(executionId);
    },
    async subscribeEvents(
      executionId: string,
      _signal?: AbortSignal,
    ): Promise<AsyncIterable<WorkflowEvent>> {
      return deps.eventBus.subscribe(executionId);
    },
    async recover() {
      for (const e of await deps.port.listRunningExecutions()) {
        void runWithCatch(e.executionId, () => drive(e));
      }
    },
    async dispose() {
      deps.eventBus.dispose();
    },
  };
}

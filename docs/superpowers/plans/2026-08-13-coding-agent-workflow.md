# Coding Agent 动态工作流实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 coding-agent 增加进程内动态工作流能力(子代理扇出 + 脚本编排),并将 backend loop 改造为首个消费者。

**Architecture:** 全进程内。workflow 执行器在 child 里创建独立子会话(同模型 + 文件工具、独立 store、空上下文),并发上限 8/总数 64;脚本经 `node:vm` 白名单沙箱求值;事件走现有 wire(RPC → backend SSE → 前端进度卡)。loop 状态载入脚本 meta,纯 reducer 校验写回。

**Tech Stack:** Bun、TypeScript(ESM/NodeNext)、`node:vm`、bun:test、Next.js 15 App Router。

**Spec:** `docs/superpowers/specs/2026-08-13-coding-agent-workflow-design.md`

---

## 文件地图

| 文件 | 责任 |
|---|---|
| `apps/coding-agent/src/core/workflow-executor.ts`(新) | 子代理引擎:`runSubagent` + `runWorkflow` + 并发/总数上限 + 预算钩子 + 事件发射 |
| `apps/coding-agent/src/core/workflow-tools.ts`(新) | 两个 PluginTool:`run_workflow`(Phase 1)、`workflow_run`(Phase 2) |
| `apps/coding-agent/src/core/workflow-evaluator.ts`(新,Phase 2) | vm 沙箱:`agent`/`pipeline` 原语 + 60s 脚本预算 |
| `apps/coding-agent/src/core/run-runtime.ts`(改) | 装配执行器 + 注册 workflow 工具 + 抽出共享的文件工具构造 |
| `packages/agent/src/runtime/agent-event.ts`(改) | `CodingAgentLoopEvent` += 4 个 workflow 事件 |
| `packages/agent-backend/src/event.ts`(改) | `CoreBackendEvent` += 4 个 workflow 事件 |
| `packages/agent-backend/src/mapping.ts`(改) | `mapRunEvent` += 4 个 case |
| `apps/web/src/hooks/useConversation.ts`(改) | workflow 状态 + 4 个 SSE 监听 |
| `apps/web/src/components/ConversationCanvas.tsx`(改) | 进度卡渲染(与 TodoPanel 同处) |
| `packages/loop/src/loop-reducer.ts`(改,Phase 3) | 导出 meta 写回校验器 |
| `apps/backend/src/features/loop/loop-step.ts`(改,Phase 3) | generator run 用 workflow;meta 校验接线 |
| `apps/backend/src/features/agent-run/execution.ts`(改,Phase 3) | run 输入带 workflow 预算(可选字段) |

---

# Phase 1:子代理原语

## Task 1:工作流事件类型(child 内部 + 产品契约)

**Files:**
- Modify: `packages/agent/src/runtime/agent-event.ts`(union 尾部)
- Modify: `packages/agent-backend/src/event.ts`(`CoreBackendEvent` union 尾部)

- [ ] **Step 1:写失败测试**

`packages/agent-backend/src/mapping.test.ts`(不存在则建,与 mapping.ts 同目录)追加:

```ts
import { describe, expect, test } from "bun:test";
import { mapRunEvent } from "./mapping.js";

describe("workflow event mapping", () => {
  test("workflow lifecycle events map 1:1 to core events", () => {
    expect(
      mapRunEvent({ id: 1, type: "workflow_started", data: { workflowId: "wf1", label: "audit", agentCount: 12 } }),
    ).toEqual({ type: "workflow_started", workflowId: "wf1", label: "audit", agentCount: 12 });
    expect(
      mapRunEvent({ id: 2, type: "workflow_agent_started", data: { workflowId: "wf1", agentId: "a1", label: "src/a.ts" } }),
    ).toEqual({ type: "workflow_agent_started", workflowId: "wf1", agentId: "a1", label: "src/a.ts" });
    expect(
      mapRunEvent({
        id: 3,
        type: "workflow_agent_completed",
        data: { workflowId: "wf1", agentId: "a1", label: "src/a.ts", ok: true },
      }),
    ).toEqual({ type: "workflow_agent_completed", workflowId: "wf1", agentId: "a1", label: "src/a.ts", ok: true });
    expect(
      mapRunEvent({
        id: 4,
        type: "workflow_completed",
        data: { workflowId: "wf1", ok: false, agentCount: 12, totalTokens: 500 },
      }),
    ).toEqual({ type: "workflow_completed", workflowId: "wf1", ok: false, agentCount: 12, totalTokens: 500 });
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `cd packages/agent-backend && bun test src/mapping.test.ts`
Expected: FAIL(TS 编译错:`CodingAgentLoopEvent`/`BackendEvent` 缺 workflow 成员)

- [ ] **Step 3:实现事件类型**

`packages/agent/src/runtime/agent-event.ts` union 尾部(最后一个 `;` 前)加:

```ts
  | { type: "workflow_started"; workflowId: string; label: string; agentCount: number }
  | { type: "workflow_agent_started"; workflowId: string; agentId: string; label: string }
  | {
      type: "workflow_agent_completed";
      workflowId: string;
      agentId: string;
      label: string;
      ok: boolean;
      error?: string;
      usage?: Readonly<Record<string, unknown>>;
    }
  | {
      type: "workflow_completed";
      workflowId: string;
      ok: boolean;
      agentCount: number;
      totalTokens: number;
    };
```

`packages/agent-backend/src/event.ts` `CoreBackendEvent` union 尾部加同构四行(与 child 1:1,字段名一致,`usage` 用 `Readonly<Record<string, unknown>>`)。

`packages/agent-backend/src/mapping.ts` switch 尾部(默认分支前)加:

```ts
    case "workflow_started":
      return {
        type: "workflow_started",
        workflowId: String(event.data.workflowId ?? ""),
        label: String(event.data.label ?? ""),
        agentCount: Number(event.data.agentCount ?? 0),
      };
    case "workflow_agent_started":
      return {
        type: "workflow_agent_started",
        workflowId: String(event.data.workflowId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
      };
    case "workflow_agent_completed": {
      const usage = event.data.usage as Readonly<Record<string, unknown>> | undefined;
      return {
        type: "workflow_agent_completed",
        workflowId: String(event.data.workflowId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
        ok: event.data.ok === true,
        ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "workflow_completed":
      return {
        type: "workflow_completed",
        workflowId: String(event.data.workflowId ?? ""),
        ok: event.data.ok === true,
        agentCount: Number(event.data.agentCount ?? 0),
        totalTokens: Number(event.data.totalTokens ?? 0),
      };
```

- [ ] **Step 4:运行确认通过**

Run: `cd packages/agent-backend && bun test src/mapping.test.ts`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/agent/src/runtime/agent-event.ts packages/agent-backend/src/event.ts packages/agent-backend/src/mapping.ts packages/agent-backend/src/mapping.test.ts
git commit -m "feat(agent): workflow lifecycle events in the wire contract"
```

## Task 2:workflow 执行器引擎

**Files:**
- Create: `apps/coding-agent/src/core/workflow-executor.ts`
- Test: `apps/coding-agent/src/core/workflow-executor.test.ts`

- [ ] **Step 1:写失败测试**

`workflow-executor.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { createEchoModelStream } from "./__fixtures__/echo-model.js"; // 见 Step 3 的 fixture
import { createWorkflowExecutor } from "./workflow-executor.js";

const events: unknown[] = [];
const emit = (e: unknown) => events.push(e);

function makeDeps() {
  return {
    makeSubagentStream: (prompt: string) =>
      createEchoModelStream(`echo:${prompt}`), // 每个子代理 echo 自己的 prompt
    summarize: async () => "[summary]",
    contextBudget: { estimate: () => 0, limit: 100000, triggerRatio: 0.7 },
    tools: [], // 空工具足够:echo 模型不调工具
    maxConcurrent: 2,
    maxTotal: 4,
    emit,
  };
}

describe("createWorkflowExecutor", () => {
  afterEach(() => events.length = 0);

  test("runWorkflow fans out, caps concurrency, and aggregates", async () => {
    const exec = createWorkflowExecutor(makeDeps() as never);
    const started: string[] = [];
    // 记录实际并发:包装 makeSubagentStream 太绕,改由 executor 的 agent 事件数断言
    const result = await exec.runWorkflow({
      workflowId: "wf1",
      label: "audit",
      items: [
        { prompt: "one", label: "a" },
        { prompt: "two", label: "b" },
        { prompt: "three", label: "c" },
      ],
    });
    expect(result.items.map((i) => i.text)).toEqual(["echo:one", "echo:two", "echo:three"]);
    expect(events.filter((e) => (e as { type: string }).type === "workflow_agent_started")).toHaveLength(3);
    expect(events.filter((e) => (e as { type: string }).type === "workflow_agent_completed")).toHaveLength(3);
    const done = events.find((e) => (e as { type: string }).type === "workflow_completed") as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  test("the total cap rejects excess agents with a clear error", async () => {
    const exec = createWorkflowExecutor(makeDeps() as never);
    await expect(
      exec.runWorkflow({
        workflowId: "wf2",
        label: "big",
        items: Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/exceeds the 4-agent cap/);
  });

  test("a budget gate can refuse new spawns", async () => {
    let budget = 2;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      budgetGate: () => (--budget >= 0 ? { allowed: true } : { allowed: false, reason: "budget exhausted" }),
    } as never);
    await expect(
      exec.runWorkflow({
        workflowId: "wf3",
        label: "gated",
        items: [1, 2, 3].map((i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/budget exhausted/);
  });

  test("schema output is parsed from the final text", async () => {
    const exec = createWorkflowExecutor(makeDeps() as never);
    const result = await exec.runSubagent({
      workflowId: "wf4",
      agentId: "a1",
      prompt: "return json",
      label: "x",
      schema: { type: "object" },
    });
    expect(result.output).toEqual({ ok: true }); // echo fixture 返回 JSON 文本
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `cd apps/coding-agent && bun test src/core/workflow-executor.test.ts`
Expected: FAIL(module not found)

- [ ] **Step 3:写 echo fixture + 实现**

`apps/coding-agent/src/core/__fixtures__/echo-model.ts`:

```ts
import type { AIMessageChunk } from "@my-agent-team/message";

/** Deterministic scripted model stream: yields one assistant text chunk
 *  then ends. The text is JSON for schema tests when the prompt asks. */
export function createEchoModelStream(text: string): (() => AsyncIterable<AIMessageChunk>) {
  return async function* () {
    yield { delta: { type: "text", text } } as AIMessageChunk;
  };
}
```

`workflow-executor.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AIMessageChunk, Message } from "@my-agent-team/message";
import type { ContextBudget, ContextSummarizer, PluginTool } from "@my-agent-team/agent";

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
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface WorkflowExecutorOptions {
  /** Build the subagent model stream (same model + reasoning as the run). */
  readonly makeSubagentStream: (sessionId: string) => (() => AsyncIterable<AIMessageChunk>);
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget;
  /** File tools only (no workflow/product tools — recursion + clobber guards). */
  readonly tools: readonly PluginTool[];
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  readonly emit: (event: unknown) => void;
  /** Optional product budget gate: consulted BEFORE each spawn. */
  readonly budgetGate?: () => { allowed: boolean; reason?: string };
}

export interface WorkflowRunResult {
  readonly items: readonly WorkflowAgentResult[];
  readonly totalTokens: number;
  readonly ok: boolean;
}

export interface WorkflowExecutor {
  runSubagent(input: { workflowId: string; agentId: string } & WorkflowAgentSpec): Promise<WorkflowAgentResult>;
  runWorkflow(input: { workflowId: string; label: string; items: readonly WorkflowAgentSpec[] }): Promise<WorkflowRunResult>;
}

export function createWorkflowExecutor(opts: WorkflowExecutorOptions): WorkflowExecutor {
  let totalSpawned = 0;
  const sem = { current: 0, max: opts.maxConcurrent, waiters: [] as Array<() => void> };

  async function acquire(): Promise<void> {
    if (sem.current < sem.max) {
      sem.current++;
      return;
    }
    await new Promise<void>((resolve) => sem.waiters.push(resolve));
  }
  function release(): void {
    const next = sem.waiters.shift();
    if (next) next();
    else sem.current--;
  }

  function gate(): void {
    if (totalSpawned >= opts.maxTotal) {
      throw new Error(`workflow exceeds the ${opts.maxTotal}-agent cap`);
    }
    if (opts.budgetGate) {
      const decision = opts.budgetGate();
      if (!decision.allowed) throw new Error(decision.reason ?? "workflow budget exhausted");
    }
    totalSpawned++;
  }

  async function runSubagent(
    input: { workflowId: string; agentId: string } & WorkflowAgentSpec,
  ): Promise<WorkflowAgentResult> {
    await acquire();
    gate();
    const sessionId = `wf:${input.workflowId}:${input.agentId}`;
    opts.emit({ type: "workflow_agent_started", workflowId: input.workflowId, agentId: input.agentId, label: input.label ?? input.agentId });
    try {
      const { createCodingAgentSession } = await import("@my-agent-team/agent");
      const { createInMemorySessionStore } = await import("@my-agent-team/agent");
      const store = createInMemorySessionStore();
      const session = createCodingAgentSession({
        sessionId,
        store,
        plugins: [],
        maxSteps: 8,
        maxForceContinues: 2,
        modelStream: opts.makeSubagentStream(sessionId),
        summarize: opts.summarize,
        contextBudget: opts.contextBudget,
      });
      const result = await session.startLoop({
        input: {
          inputId: input.agentId,
          message: { role: "user" as const, text: input.prompt },
        },
        run: {
          runId: sessionId,
          model: { providerId: "echo", modelId: "echo" },
          configRevision: 0,
        },
        metadata: { conversationId: "", agentMemberId: "", branchId: "" },
      } as never);
      void store.close().catch(() => {});
      const text = (result.messages?.at(-1)?.text ?? "").trim();
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
        label: input.label ?? input.agentId,
        text,
        ok: result.status === "completed" && !parseError,
        ...(output !== undefined ? { output } : {}),
        ...(parseError ? { error: parseError } : {}),
        ...(result.usage ? { usage: result.usage as Readonly<Record<string, unknown>> } : {}),
      };
      opts.emit({
        type: "workflow_agent_completed",
        workflowId: input.workflowId,
        agentId: input.agentId,
        label: agentResult.label,
        ok: agentResult.ok,
        ...(agentResult.error ? { error: agentResult.error } : {}),
        ...(agentResult.usage ? { usage: agentResult.usage } : {}),
      });
      return agentResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.emit({
        type: "workflow_agent_completed",
        workflowId: input.workflowId,
        agentId: input.agentId,
        label: input.label ?? input.agentId,
        ok: false,
        error: message,
      });
      return { label: input.label ?? input.agentId, text: "", ok: false, error: message };
    } finally {
      release();
    }
  }

  async function runWorkflow(input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
  }): Promise<WorkflowRunResult> {
    opts.emit({ type: "workflow_started", workflowId: input.workflowId, label: input.label, agentCount: input.items.length });
    const results = await Promise.all(
      input.items.map((item, i) =>
        runSubagent({ workflowId: input.workflowId, agentId: `a${i}`, ...item }),
      ),
    );
    const totalTokens = results.reduce(
      (acc, r) => acc + Number((r.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0),
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
```

> 注意:`startLoop` 的类型对子代理并不精确(工具集不同)。若 TS 报 `CodingLoopInput` 缺字段,按最小快照补 `systemPrompt: null` / `permissionMode: null` / `skillRoots: null`——以 tsc 报错为准补齐,不伪造语义。

- [ ] **Step 4:运行确认通过**

Run: `cd apps/coding-agent && bun test src/core/workflow-executor.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5:Commit**

```bash
git add apps/coding-agent/src/core/workflow-executor.ts apps/coding-agent/src/core/workflow-executor.test.ts apps/coding-agent/src/core/__fixtures__/echo-model.ts
git commit -m "feat(coding-agent): in-process workflow executor with caps and budget gate"
```

## Task 3:run_workflow 工具 + 装配进 run-runtime

**Files:**
- Create: `apps/coding-agent/src/core/workflow-tools.ts`
- Modify: `apps/coding-agent/src/core/run-runtime.ts`(工具构造抽出 + 执行器装配 + 工具注册)

- [ ] **Step 1:写失败测试**

`apps/coding-agent/src/core/workflow-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createWorkflowTools } from "./workflow-tools.js";

describe("createWorkflowTools", () => {
  test("run_workflow exposes items + concurrency and executes the executor", async () => {
    const calls: unknown[] = [];
    const tools = createWorkflowTools({
      runWorkflow: async (input) => {
        calls.push(input);
        return { items: [], totalTokens: 0, ok: true };
      },
      runScript: async () => {
        throw new Error("not in phase 1");
      },
    });
    const tool = tools.find((t) => t.name === "run_workflow");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema?.type).toBe("object");
    const result = await tool!.execute({ items: [{ prompt: "hi" }] }, undefined, { callId: "c1" });
    expect(result).toEqual({ items: [], totalTokens: 0, ok: true });
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2:运行确认失败** → `cd apps/coding-agent && bun test src/core/workflow-tools.test.ts`,Expected: FAIL

- [ ] **Step 3:实现**

`workflow-tools.ts`:

```ts
import type { PluginTool } from "@my-agent-team/agent";
import type { WorkflowRunResult, WorkflowAgentSpec } from "./workflow-executor.js";

export interface WorkflowToolDeps {
  readonly runWorkflow: (input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
  }) => Promise<WorkflowRunResult>;
  /** Phase 2 填充;Phase 1 传抛错桩,run_workflow 是唯一工具。 */
  readonly runScript: (input: { script: string; args?: unknown }) => Promise<WorkflowRunResult>;
}

export function createWorkflowTools(deps: WorkflowToolDeps): readonly PluginTool[] {
  const runWorkflow: PluginTool = {
    name: "run_workflow",
    description:
      "Fan out independent subagent tasks in parallel and aggregate their results. Each item gets its own isolated agent session (same model, file tools). Use for audits, migrations, and multi-source research. Items: [{prompt, schema?, label?}]. Returns per-item text and schema-parsed output.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        concurrency: { type: "number", maximum: 8 },
        items: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              label: { type: "string" },
              schema: { type: "object" },
            },
            required: ["prompt"],
          },
        },
      },
      required: ["items"],
    },
    async execute(args) {
      const items = Array.isArray(args.items) ? args.items : [];
      const workflowId = `wf-${Date.now().toString(36)}`;
      const result = await deps.runWorkflow({
        workflowId,
        label: typeof args.label === "string" ? args.label : "workflow",
        items: items.map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            prompt: String(item.prompt ?? ""),
            ...(typeof item.label === "string" ? { label: item.label } : {}),
            ...(item.schema && typeof item.schema === "object" ? { schema: item.schema } : {}),
          };
        }),
      });
      return { items: result.items, totalTokens: result.totalTokens, ok: result.ok };
    },
  };
  return [runWorkflow];
}
```

`run-runtime.ts` 装配(把 `assembleRunRuntime` 里 `const tools: PluginTool[] = [...]` 的构造抽成 `buildFileTools(deps)` 局部函数,再在 `plugins` 定义前加):

```ts
  const executor = createWorkflowExecutor({
    makeSubagentStream: (sessionId) => async function* () {
      const run = activeRun;
      if (!run) throw new Error("no active run");
      const catalog = await deps.modelRuntime.getCatalog();
      const model = catalog.models.find(
        (m) => `${m.providerId}/${m.modelId}` === resolveModelAlias(run.model.modelId),
      );
      if (!model) throw new Error(`model not found: ${run.model.modelId}`);
      const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
      const stream = deps.modelRuntime.stream(model.providerId, model.modelId, messagesOf(sessionId), {
        signal: timeoutSignal,
        cacheControl: true,
      });
      yield* stream;
    },
    summarize,
    contextBudget,
    tools: fileTools,
    maxConcurrent: 8,
    maxTotal: 64,
    emit: (event) => sessionEmit?.(event as never),
  });
  const workflowTools = createWorkflowTools({
    runWorkflow: (input) => executor.runWorkflow(input),
    runScript: async () => {
      throw new Error("workflow_run arrives in phase 2");
    },
  });
```

> `messagesOf(sessionId)` = 子代理流与主 modelStream 同构(直接调 `deps.modelRuntime.stream`),不需要 `activeRun` 外的信息——子代理消息由 session 自己喂;实现时把主 modelStream 的 reasoning 提取逻辑复用成一个共享闭包 `streamFor(messages, signal)`。保持行为不变,不复制 reasoning 分支。

`tools` 数组末尾加 `...workflowTools`(在 `nativeToolsPlugin` 之前定义,注意 `fileTools` 变量持有核心工具数组,`nativeToolsPlugin = { name: "native-tools", tools: fileTools }`)。

- [ ] **Step 4:运行确认通过**

Run: `cd apps/coding-agent && bun test src/core/` + `cd /root/my-agent-team && bun run typecheck`
Expected: PASS / 42 tasks

- [ ] **Step 5:Commit**

```bash
git add apps/coding-agent/src/core/
git commit -m "feat(coding-agent): run_workflow tool wired into the run runtime"
```

## Task 4:前端进度卡

**Files:**
- Modify: `apps/web/src/hooks/useConversation.ts`
- Modify: `apps/web/src/components/ConversationCanvas.tsx`(进度卡组件,与 TodoPanel 同文件区域)

- [ ] **Step 1:状态 + 监听**

`useConversation.ts`(与 `setRunTodosState` 同层)加:

```ts
export interface WorkflowAgentState {
  readonly label: string;
  readonly status: "running" | "done" | "failed";
  readonly error?: string;
}
export interface WorkflowRunState {
  readonly label: string;
  readonly agentCount: number;
  readonly agents: ReadonlyMap<string, WorkflowAgentState>;
  readonly ok: boolean | null;
  readonly totalTokens: number;
}

const [workflows, setWorkflows] = useState<ReadonlyMap<string, WorkflowRunState>>(new Map());
const upsertWorkflow = useCallback((workflowId: string, patch: (w: WorkflowRunState | undefined) => WorkflowRunState | undefined) => {
  setWorkflows((prev) => {
    const next = new Map(prev);
    const updated = patch(prev.get(workflowId));
    if (updated) next.set(workflowId, updated);
    else next.delete(workflowId);
    return next;
  });
}, []);
```

SSE 监听(与 native_tool 监听同块)加:

```ts
      const onWorkflow = (e: Event) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
          const workflowId = String(ev.workflowId ?? "");
          switch ((e.target as { type?: string })?.type) {
            case "workflow_started":
              upsertWorkflow(workflowId, () => ({
                label: String(ev.label ?? ""),
                agentCount: Number(ev.agentCount ?? 0),
                agents: new Map(),
                ok: null,
                totalTokens: 0,
              }));
              break;
            case "workflow_agent_started":
              upsertWorkflow(workflowId, (w) =>
                w
                  ? { ...w, agents: new Map(w.agents).set(String(ev.agentId ?? ""), { label: String(ev.label ?? ""), status: "running" }) }
                  : w,
              );
              break;
            case "workflow_agent_completed":
              upsertWorkflow(workflowId, (w) =>
                w
                  ? {
                      ...w,
                      agents: new Map(w.agents).set(String(ev.agentId ?? ""), {
                        label: String(ev.label ?? ""),
                        status: ev.ok === true ? "done" : "failed",
                        ...(typeof ev.error === "string" ? { error: ev.error } : {}),
                      }),
                    }
                  : w,
              );
              break;
            case "workflow_completed":
              upsertWorkflow(workflowId, (w) =>
                w ? { ...w, ok: ev.ok === true, totalTokens: Number(ev.totalTokens ?? 0) } : w,
              );
              break;
          }
        } catch {
          /* malformed - ignore */
        }
      };
      es.addEventListener("workflow_started", onWorkflow);
      es.addEventListener("workflow_agent_started", onWorkflow);
      es.addEventListener("workflow_agent_completed", onWorkflow);
      es.addEventListener("workflow_completed", onWorkflow);
```

- [ ] **Step 2:进度卡组件**

`ConversationCanvas.tsx`(TodoPanel 旁)加 `WorkflowPanel`,接收 `workflows` + `runId` 过滤(仅显示当前 run 的 workflow——用 `workflowId` 前缀 `wf-<ts>`,按时间保留最新;v1 显示全部进行中):

```tsx
function WorkflowPanel({ workflows }: { workflows: ReadonlyMap<string, WorkflowRunState> }) {
  const running = [...workflows.entries()].filter(([, w]) => w.ok === null);
  if (running.length === 0) return null;
  return (
    <div className="rounded-lg border p-3 text-sm">
      {running.map(([id, w]) => {
        const done = [...w.agents.values()].filter((a) => a.status !== "running").length;
        return (
          <div key={id}>
            <div className="font-medium">
              {w.label} · {done}/{w.agentCount} agents
            </div>
            <ul>
              {[...w.agents.entries()].map(([agentId, a]) => (
                <li key={agentId} className={a.status === "failed" ? "text-red-600" : ""}>
                  {a.status === "running" ? "⏳" : a.status === "done" ? "✓" : "✗"} {a.label}
                  {a.error ? ` — ${a.error.slice(0, 80)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
```

> 样式以现有 TodoPanel 的 tailwind 类为参照,保持一致(space/2 格式由 biome 处理)。

- [ ] **Step 3:验证**

Run: `cd /root/my-agent-team && bun run typecheck && bun run lint`
Expected: 42/42 + 23/23

- [ ] **Step 4:Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): workflow progress card from SSE events"
```

## Task 5:Phase 1 端到端验收

- [ ] **Step 1:集成测试**——`apps/coding-agent/src/core/create-runtime.test.ts` 补一个 case:用 scripted 模型(首轮发 `run_workflow` 工具调用,items=2 个 echo prompt)→ 断言 outcome 完成 + 事件流含 4 类 workflow 事件 + 工具结果含 2 个 item text。参照现有 create-runtime.test 的 harness 写。
- [ ] **Step 2:全量门禁**

Run: `cd /root/my-agent-team && bun run typecheck && bun run lint && bun run test`
Expected: 全绿

- [ ] **Step 3:Commit + 推分支**

```bash
git add -A && git commit -m "test(coding-agent): phase 1 workflow end-to-end" && git push -u origin feat/coding-agent-workflow
```

---

# Phase 2:脚本求值器

## Task 6:vm 沙箱求值器

**Files:**
- Create: `apps/coding-agent/src/core/workflow-evaluator.ts`
- Test: `apps/coding-agent/src/core/workflow-evaluator.test.ts`

- [ ] **Step 1:失败测试**

```ts
import { describe, expect, test } from "bun:test";
import { evaluateWorkflowScript } from "./workflow-evaluator.js";

const primitives = {
  agent: async (prompt: string) => ({ text: `echo:${prompt}`, output: undefined, ok: true, label: "" }),
  pipeline: async (items: readonly unknown[], fn: (item: unknown) => Promise<unknown>) =>
    Promise.all(items.map(fn)),
};

describe("evaluateWorkflowScript", () => {
  test("runs top-level await scripts with agent + pipeline", async () => {
    const result = await evaluateWorkflowScript({
      script: `const found = await agent("find"); const all = await pipeline(found.text.split(","), (x) => agent(x)); return all.length;`,
      args: undefined,
      primitives: primitives as never,
    });
    expect(result.value).toBe(1);
  });

  test("args are passed as a global", async () => {
    const result = await evaluateWorkflowScript({
      script: `return args.count * 2;`,
      args: { count: 21 },
      primitives: primitives as never,
    });
    expect(result.value).toBe(42);
  });

  test("fs/process/require are absent", async () => {
    await expect(
      evaluateWorkflowScript({
        script: `return typeof process;`,
        args: undefined,
        primitives: primitives as never,
      }),
    ).rejects.toThrow(/process is not defined/);
  });

  test("the 60s budget aborts a stalled script", async () => {
    await expect(
      evaluateWorkflowScript({
        script: `while (true) {}`,
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2:失败确认** → `cd apps/coding-agent && bun test src/core/workflow-evaluator.test.ts`

- [ ] **Step 3:实现**

```ts
import vm from "node:vm";

export interface WorkflowPrimitives {
  readonly agent: (prompt: string, opts?: { schema?: unknown; label?: string }) => Promise<unknown>;
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
  const context = vm.createContext({ agent, pipeline, args: input.args }, { name: "workflow-script" });
  const wrapped = `(async () => { ${input.script} })()`;
  const promise = vm.runInContext(wrapped, context, { timeout: timeoutMs }) as Promise<unknown>;
  const timer = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error("workflow script timed out")), timeoutMs);
    promise.finally(() => clearTimeout(id)).catch(() => {});
  });
  const value = await Promise.race([promise, timer]);
  return { value };
}
```

- [ ] **Step 4:通过确认** → `cd apps/coding-agent && bun test src/core/workflow-evaluator.test.ts`

- [ ] **Step 5:Commit**

```bash
git add apps/coding-agent/src/core/workflow-evaluator.ts apps/coding-agent/src/core/workflow-evaluator.test.ts
git commit -m "feat(coding-agent): sandboxed workflow script evaluator"
```

## Task 7:workflow_run 工具 + 脚本落盘

**Files:**
- Modify: `apps/coding-agent/src/core/workflow-tools.ts`(加 `workflow_run` 工具)
- Modify: `apps/coding-agent/src/core/run-runtime.ts`(`runScript` 桩 → 真实实现)

- [ ] **Step 1:`workflow-tools.ts` 加工具**

`createWorkflowTools` 的返回数组加(需要 `deps.runScript` + 一个新 deps 字段 `writeScript: (name: string, content: string) => void`):

```ts
  const runScript: PluginTool = {
    name: "workflow_run",
    description:
      "Run an orchestration script (top-level-await JS) that fans out subagents via agent() and pipeline(). Scripts have NO fs/network access - agents do the work. Write scripts to .workflows/<name>.js for reuse.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", maxLength: 32768 },
        name: { type: "string" },
        args: { type: "object" },
      },
      required: ["script"],
    },
    async execute(args) {
      const script = typeof args.script === "string" ? args.script : "";
      if (typeof args.name === "string" && args.name.length > 0) {
        deps.writeScript(args.name, script);
      }
      const result = await deps.runScript({ script, args: args.args });
      return { ...result, scriptSaved: typeof args.name === "string" };
    },
  };
  return [runWorkflow, runScript];
```

- [ ] **Step 2:`run-runtime.ts` 接真实实现**

```ts
  const workflowTools = createWorkflowTools({
    runWorkflow: (input) => executor.runWorkflow(input),
    runScript: async ({ script, args }) => {
      const result = await evaluateWorkflowScript({
        script,
        args,
        primitives: {
          agent: (prompt, opts) =>
            executor.runSubagent({
              workflowId: currentWorkflowId(),
              agentId: randomUUID(),
              prompt,
              ...(opts?.schema ? { schema: opts.schema as never } : {}),
              ...(opts?.label ? { label: opts.label } : {}),
            }),
          pipeline: async (items, fn) => {
            const runs = items.map((item) => fn(item));
            return Promise.all(runs);
          },
        },
      });
      return { items: [], totalTokens: 0, ok: true, scriptValue: result.value };
    },
    writeScript: (name, content) => {
      const dir = join(deps.workspaceRoot, ".workflows");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.js`), content);
    },
  });
```

> `currentWorkflowId()` = 每 run 一个稳定 id(workflow_run 调用时生成,`agent()` 内共享);脚本结果的 `value` 进工具结果。pipeline 的并发限制沿用执行器信号量(Phase 1 的信号量已内置,`Promise.all` 直通)。

- [ ] **Step 3:验证** → `cd /root/my-agent-team && bun run typecheck && bun run lint && bun run test`
- [ ] **Step 4:Commit**

```bash
git add apps/coding-agent/src/core/
git commit -m "feat(coding-agent): workflow_run tool with sandboxed scripts and .workflows persistence"
```

## Task 8:Phase 2 验收 + push

- [ ] **Step 1:** `create-runtime.test.ts` 补 scripted 模型用例:模型首轮写脚本到 `.workflows/audit.js` + 调 `workflow_run` → 断言文件落盘 + 结果 + 事件。临时目录 workspace(参照现有测试的 mkdtemp 模式)。
- [ ] **Step 2:** 全量门禁 `bun run typecheck && bun run lint && bun run test`
- [ ] **Step 3:** commit + push

---

# Phase 3:Loop 消费者

## Task 9:reducer 导出 meta 写回校验器

**Files:**
- Modify: `packages/loop/src/loop-reducer.ts`
- Modify: `packages/loop/src/index.ts`
- Test: `packages/loop/src/loop-reducer.test.ts`

- [ ] **Step 1:失败测试**

```ts
import { validateLoopMetaPatch } from "./loop-reducer.js";
// 合法:item 状态按 step 顺序前进
const valid = validateLoopMetaPatch(
  { items: [{ id: "i1", step: "generated", content: "" }] },
  { items: [{ id: "i1", step: "evaluated", content: "x" }] },
);
expect(valid.ok).toBe(true);
// 非法:回跳 step / 未知 item / 非法状态名
expect(validateLoopMetaPatch({ items: [] }, { items: [{ id: "i9", step: "generated" }] }).ok).toBe(false);
```

- [ ] **Step 2:实现**——`validateLoopMetaPatch(before, after): { ok: true } | { ok: false; reason: string }`:
  - `after` 的 item id 集合 ⊆ `before` 的 id 集合 ∪ 本次可新建的 id(生成阶段引入的新 item 必须有 `generated` 初始 step);
  - 每个 item 的 step 只能按 7 步顺序前进或停留,不能回退;
  - 状态名必须在 7 步枚举内;`verdict` 值必须在枚举内。
  - 纯函数,无 I/O;复用现有 `loopReducer` 的 step 常量。
- [ ] **Step 3:通过 + commit** → `bun test packages/loop && git commit -m "feat(loop): meta writeback validator from the pure reducer invariants"`

## Task 10:loop workflow 脚本模板(bundled)

**Files:**
- Create: `skills/loop-workflow/SKILL.md` + `skills/loop-workflow/workflow.js`(模板脚本:meta 块 + 生成/评估/重试 body)

- [ ] **Step 1:** 模板脚本(body 用 `agent`/`pipeline` 写生成→评估→条件重试循环;meta 块 = `export const meta = { items: [...], budgetSpent: 0 }`,注释标明 meta 由产品校验器接管、模型只能追加合法转移)。
- [ ] **Step 2:** SKILL.md 描述 loop 语义 + 脚本用法 + 约束(meta 写回规则、预算上限)。
- [ ] **Step 3:commit** → `feat(loop): bundled loop workflow template`

## Task 11:loop-step 接线(meta 校验 + workflow 化生成)

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify: `apps/backend/src/features/agent-run/execution.ts`(可选 `run.workflowBudgetTokens` 字段,预算钩子用)

- [ ] **Step 1:run 输入加可选预算字段**——`BackendRunInput` 的 run snapshot 加 `workflowBudgetTokens?: number`;backend loop-step 派发时把 loop 剩余预算写入;child 的 `assembleRunRuntime` 读 `input.run.workflowBudgetTokens` → `executor.budgetGate`(累计 spawn 估算 tokens 耗尽即拒)。
- [ ] **Step 2:loop-step 的 generator run 改 workflow 化**——generator 的 systemPrompt 指向 loop-workflow 模板;run 完成后读 workspace `.workflows/loop.js` 的 meta → `validateLoopMetaPatch(beforeMeta, afterMeta)` → 通过则写回 STATE.md(现有写回路径不变,只换数据来源),不通过则该 step 判 failed + 保留 before。
- [ ] **Step 3:evaluator 独立 run 删除**——生成/评估/重试收编进脚本后,evaluator dispatch 分支删除,verdict 从 meta 读。
- [ ] **Step 4:测试迁移**——`loop-step.test.ts` 的 mockSessionFactory 改为回写 `.workflows/loop.js`(meta 合法/非法两个 fixture 分别断言通过/拒绝);`scheduler.test.ts` fixture 同步。
- [ ] **Step 5:全量门禁 + commit**

---

## Self-Review 记录

1. **Spec 覆盖**:§3 原语→Task 2/3;§3.3 边界(工具白名单/无插件/abort)→executor 实现 + Task 3 装配;§4 事件→Task 1 + Task 4;§5 求值器→Task 6/7;§6 loop→Task 9/10/11;§7 前端→Task 4;§8 实施顺序→三 Phase 对应。
2. **占位符扫描**:无 TBD/TODO;子代理 `startLoop` 的 run 快照最小字段以 tsc 为准补齐(已注明)。
3. **类型一致性**:`WorkflowRunResult`/`WorkflowAgentSpec`/事件字段名三处一致(`workflowId`/`agentId`/`label`/`ok`/`totalTokens`);`runWorkflow` deps 签名 Task 3 与 Task 7 一致。

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ContextBudget,
  type ContextSummarizer,
  createInMemorySessionStore,
  createOmaSession,
  type OmaLoopEvent,
  type OmaSession,
  type Plugin,
  type PluginRuntime,
  type PluginTool,
  type SessionStore,
} from "@chengchenccc/agent";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "@chengchenccc/agent-backend";
import { type ModelRuntime, resolveModelAlias } from "@chengchenccc/ai";
import type { AIMessageChunk, JsonSchema } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import {
  createBashTool,
  createDdgWebSearchPort,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createPortWebFetchTool,
  createPortWebSearchTool,
  createReadImageTool,
  createReadTool,
  createStdWebFetchPort,
  createTreeTool,
  createWriteTool,
  type WebFetchPort,
  type WebSearchPort,
} from "@chengchenccc/tools-common";
import { loadProjectSettings } from "../settings/project-settings.js";
import { mountWorkspaceMcpServers, withCallTimeout } from "../tools/mcp-mount.js";
import { createSkill } from "../tools/skill.js";
import { createTodo, createTodoReadTool } from "../tools/todo.js";
import { createFileTodoStore, readTodoFile } from "../tools/todo-store.js";
import { evaluateWorkflowScript } from "../workflow/workflow-evaluator.js";
import { createWorkflowExecutor, type WorkflowAgentResult } from "../workflow/workflow-executor.js";
import { createWorkflowTools, isValidWorkflowName } from "../workflow/workflow-tools.js";
import { fakeProvider } from "./fake-provider.js";
import { loadRuntimeCatalog, registerProvidersFromCatalog } from "./runtime-catalog.js";
import { loadStreamRules } from "./stream-rules.js";

/** Token estimation via content char/4 (approx 1 token per 4 chars of
 *  English/code). More accurate than JSON.stringify char/4 which includes
 *  ~30% syntax overhead from key names, quotes, braces. Counts actual text +
 *  block content, adds a fixed overhead per message for role/structure
 *  framing. Swap for a real tokenizer (tiktoken, provider SDK) by replacing
 *  this function — the ContextBudget.estimate interface is the extension
 *  point. */
function estimateMessageTokens(message: Message): number {
  let chars = message.text?.length ?? 0;
  if (message.blocks) {
    for (const b of message.blocks) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      else if (b.type === "tool_result" && typeof b.content === "string") chars += b.content.length;
      else if (b.type === "thinking" && typeof b.text === "string") chars += b.text.length;
    }
  }
  // ~4 chars/token for content + 4 tokens framing overhead per message
  // (role tag, separators — matches Anthropic's documented overhead).
  return Math.ceil(chars / 4) + 4;
}

/** Default native tool timeout (ms) for file/web/bash unless overridden. */
const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000;

function resolveNativeToolTimeout(defaultMs: number): number {
  const capRaw = process.env.OMA_MAX_TOOL_TIMEOUT_MS;
  const cap = capRaw ? Number(capRaw) : 0;
  if (Number.isFinite(cap) && cap > 0) return Math.min(defaultMs, cap);
  return defaultMs;
}

async function withToolTimeout(
  tool: PluginTool,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  options: { callId?: string; onOutput?: (partial: string) => void } | undefined,
  defaultMs: number,
): Promise<Readonly<Record<string, unknown>>> {
  const timeoutMs = resolveNativeToolTimeout(defaultMs);
  if (timeoutMs <= 0) return tool.execute(input, signal, options);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withCallTimeout(
      tool.execute(input, controller.signal, options),
      tool.name,
      timeoutMs,
      signal,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function wrapNativeTool(tool: PluginTool, defaultMs = DEFAULT_NATIVE_TOOL_TIMEOUT_MS): PluginTool {
  return {
    ...tool,
    timeoutMs: resolveNativeToolTimeout(defaultMs),
    execute: (input, signal, options) => withToolTimeout(tool, input, signal, options, defaultMs),
  };
}

/** Dependencies for ONE Run's runtime assembly. The runtime is per-Run: a

/** Dependencies for ONE Run's runtime assembly. The runtime is per-Run: a
 *  fresh in-memory SessionStore and a fresh OmaSession are created
 *  for every execute() - no state is shared across Runs except the
 *  process-level Provider/ModelRuntime. */
export interface RunRuntimeDeps {
  workspaceRoot: string;
  /** Gates tool installation: read_only runs omit write/edit/bash. */
  workspaceAccess: "read_only" | "read_write";
  runId: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id of the Run's model. The context
   *  budget and the summarizer bind to THIS model - never the catalog's
   *  first entry (which may be a different window or a different provider). */
  modelId: string;
  /** Skill pack roots (absolute dirs scanned for SKILL.md). Frozen per Run. */
  skillRoots: readonly string[];
  webSearch?: WebSearchPort;
  webFetch?: WebFetchPort;
  /** Real-time session-file persistence (pi appendMessage): fires after
   *  every conversational persist with the canonical messages written. */
  onPersistMessages?: (messages: readonly Message[]) => void;
  /** Standalone modes (TUI/print/json) expose oma's own todo tools backed by
   *  `<workspace>/.oma/todo.json`. Backend-invoked RPC mode leaves this off:
   *  todo comes from the backend-injected product MCP. */
  enableNativeTodo?: boolean;
}

export interface RunRuntime {
  readonly runId: string;
  readonly store: SessionStore;
  readonly session: OmaSession;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget | undefined;
  /** Set before startLoop so modelStream resolves the run's model. */
  setActiveRun(run: AgentRunSnapshot<"oma"> | null): void;
  /** Workflow mode: execute a vm-sandboxed script (agent() subagents) and
   *  return its value. Used directly by create-runtime when the Run input
   *  carries `workflow`, and by the workflow_run tool otherwise. */
  executeWorkflow(input: {
    script: string;
    args?: unknown;
  }): Promise<{ ok: boolean; totalTokens: number; value: unknown }>;
  /** Subagent usage accumulated across workflow_agent_completed events
   *  (T5/B6: the run's outcome merges it so fan-out spend reaches the
   *  product ledger, not just the advisory gate). */
  workflowUsage(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Close MCP clients etc. Call after the run settles. */
  close(): Promise<void>;
}

/** Single provider assembly shared by the CLI catalog (--list-models) and
 *  Run loops: register built-in providers from the process env. The fake
 *  deterministic provider is available for tests. */
export function registerBuiltinProviders(
  runtime: ModelRuntime,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.OMA_FAKE_PROVIDER === "1") {
    runtime.registerProvider(fakeProvider(env));
    return;
  }
  const catalog = loadRuntimeCatalog(env);
  registerProvidersFromCatalog(runtime, catalog, env);
}

/** Build the complete Runtime assembly for exactly ONE Run. The Run's
 *  in-memory SessionStore is created here (never shared with other Runs);
 *  the model is resolved per run from the AgentRunSnapshot. */
export async function assembleRunRuntime(deps: RunRuntimeDeps): Promise<RunRuntime> {
  const store = createInMemorySessionStore();
  // `.oma/settings.json` P0 knobs are normalized into the process env for
  // the compatibility shim: the existing env-reading code paths pick them up
  // without threading a settings object through every consumer.
  // ponytail: per-process shim; a future refactor can pass settings as a dep.
  const projectSettings = loadProjectSettings(deps.workspaceRoot);
  if (projectSettings.maxSteps !== undefined)
    process.env.OMA_MAX_STEPS = String(projectSettings.maxSteps);
  if (projectSettings.modelTimeoutMs !== undefined) {
    process.env.OMA_MODEL_TIMEOUT_MS = String(projectSettings.modelTimeoutMs);
  }
  if (projectSettings.mcpTimeoutMs !== undefined) {
    process.env.OMA_MCP_TIMEOUT_MS = String(projectSettings.mcpTimeoutMs);
  }
  if (projectSettings.disableWeb !== undefined) {
    process.env.OMA_DISABLE_WEB = projectSettings.disableWeb ? "1" : "0";
  }
  if (projectSettings.titleEnabled !== undefined) {
    process.env.OMA_TITLE_ENABLED = projectSettings.titleEnabled ? "1" : "0";
  }
  if (projectSettings.memoryExtract !== undefined) {
    process.env.OMA_MEMORY_EXTRACT = projectSettings.memoryExtract ? "1" : "0";
  }
  if (projectSettings.memoryModel !== undefined) {
    process.env.OMA_MEMORY_MODEL = projectSettings.memoryModel;
  }
  if (projectSettings.bashTimeoutMs !== undefined) {
    process.env.OMA_BASH_TIMEOUT_MS = String(projectSettings.bashTimeoutMs);
  }
  if (projectSettings.maxToolTimeoutMs !== undefined) {
    process.env.OMA_MAX_TOOL_TIMEOUT_MS = String(projectSettings.maxToolTimeoutMs);
  }
  const catalog = await deps.modelRuntime.getCatalog();
  // The Run's model is the ONLY budget/summarizer authority. A catalog-first
  // model with a different window would compact at the wrong threshold or
  // overflow the real context.
  const currentModel = catalog.models.find(
    (m) => `${m.providerId}/${m.modelId}` === resolveModelAlias(deps.modelId),
  );
  if (!currentModel) {
    throw new Error(`model not found in catalog: ${deps.modelId}`);
  }
  const fileTools: PluginTool[] = [
    createReadTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createReadImageTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createTreeTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createGlobTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
    createGrepTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
  ];
  if (deps.workspaceAccess === "read_write") {
    fileTools.push(createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    fileTools.push(createEditTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    fileTools.push(createBashTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool);
  }
  // Generic .mcp.json mounting (ADR 0022): user servers + knowledge.
  // Skips "product-tools" (the manifest path owns it) and names that
  // collide with the native table. The mounted clients join the run's
  // teardown set so stdio children never outlive the run.
  const mounted = await mountWorkspaceMcpServers(
    deps.workspaceRoot,
    new Set(fileTools.map((t) => t.name)),
  );
  fileTools.push(...mounted.tools);
  const closeMounted = mounted.close;
  // Web tools default ON via the std ports (DDG search + guarded fetch);
  // OMA_DISABLE_WEB=1 opts out for air-gapped workspaces.
  if (process.env.OMA_DISABLE_WEB !== "1") {
    fileTools.push(
      createPortWebSearchTool(deps.webSearch ?? createDdgWebSearchPort()) as unknown as PluginTool,
      createPortWebFetchTool(deps.webFetch ?? createStdWebFetchPort()) as unknown as PluginTool,
    );
  }

  const bashDefault = Number(process.env.OMA_BASH_TIMEOUT_MS) || DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
  const nativeTools = fileTools.map((t) =>
    wrapNativeTool(t, t.name === "bash" ? bashDefault : DEFAULT_NATIVE_TOOL_TIMEOUT_MS),
  );
  const nativeToolsPlugin: Plugin = {
    name: "native-tools",
    tools: [...nativeTools, ...mounted.tools],
  };
  const plugins: Plugin[] = [nativeToolsPlugin, createSkill({ roots: deps.skillRoots })];
  if (deps.enableNativeTodo) {
    const todoStore = createFileTodoStore(deps.workspaceRoot);
    const todoBase = createTodo({ sessionId: deps.runId, store: todoStore });
    plugins.push({
      name: todoBase.name,
      hooks: todoBase.hooks,
      tools: [
        ...(todoBase.tools ?? []),
        createTodoReadTool({ sessionId: deps.runId, store: todoStore }),
      ],
      meta: [
        {
          name: "Current Tasks",
          render: () => {
            const items = readTodoFile(deps.workspaceRoot);
            if (items.length === 0) return "None yet. Use todo_write to track tasks.";
            const marks: Record<string, string> = {
              pending: "- [ ]",
              in_progress: "- [~]",
              done: "- [x]",
              cancelled: "- [ ]",
            };
            return items
              .map((t) => `${marks[t.status] ?? "- [ ]"} ${t.text} (id: ${t.id})`)
              .join("\n");
          },
        },
      ],
    });
  }

  let activeRun: AgentRunSnapshot<"oma"> | null = null;

  // Resolve the model display identity for a run's ref - used by the Session
  // to render the per-loop Meta (workspace/model fact line). The Session is
  // the sole Meta owner; the Run runtime never passes a meta string.
  const resolveModel = async (modelId: string): Promise<{ provider: string; id: string }> => {
    const catalog = await deps.modelRuntime.getCatalog();
    const model = catalog.models.find(
      (m) => `${m.providerId}/${m.modelId}` === resolveModelAlias(modelId),
    );
    if (!model) throw new Error(`model not found: ${modelId}`);
    return { provider: model.providerId, id: model.modelId };
  };

  // Summarizer: call the RUN's model through ModelRuntime with full Message[]
  // input and AbortSignal support. Same provider/credentials as the run -
  // no surprise provider switch, no catalog-first cost surprises. No
  // summaryModel config until real cost data demands one.
  const summarize: ContextSummarizer = async (messages, signal) => {
    const summaryMessages: Message[] = [
      {
        role: "system",
        text: "Summarize the following conversation messages, preserving tool calls, results, decisions and next steps.",
      },
      ...messages,
    ];
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const stream = deps.modelRuntime.stream(
      currentModel.providerId,
      currentModel.modelId,
      summaryMessages,
      { signal: combined },
    );
    const iter = stream[Symbol.asyncIterator]();
    let text = "";
    try {
      for (;;) {
        const next = await nextBounded(iter, combined, timeoutSignal);
        if (next.done) break;
        if (next.value.delta?.type === "text") text += next.value.delta.text;
      }
    } finally {
      if (!combined.aborted) await iter.return?.().catch(() => {});
    }
    return text || "[empty summary]";
  };

  // ContextBudget from the RUN model's context window: compaction triggers
  // at the same threshold the real model would overflow, neither premature
  // nor too late.
  const contextBudget: ContextBudget = {
    estimate: (m) => estimateMessageTokens(m),
    limit: currentModel.contextWindow,
    triggerRatio: 0.7,
  };

  // Wall-clock cap on a single model call: a silent/stuck provider must not
  // leave the Run in `running` forever. The timeout aborts the call and the
  // Run fails (no auto-retry). Overridable via env for tests.
  const modelTimeoutMs = (() => {
    const raw = process.env.OMA_MODEL_TIMEOUT_MS;
    return raw ? Number(raw) || 300_000 : 300_000;
  })();

  /** Advance an async iterator, racing each chunk against the combined
   *  signal. Providers that ignore the signal (e.g. a generator sleeping
   *  forever) can no longer hold the Run hostage: abort rejects immediately
   *  instead of waiting for the provider to notice. */
  const nextBounded = async <T>(
    iter: AsyncIterator<T>,
    combined: AbortSignal,
    timeoutSignal: AbortSignal,
  ): Promise<IteratorResult<T>> => {
    if (combined.aborted) {
      throw new Error(timeoutSignal.aborted ? "model timed out" : "model call aborted");
    }
    let settled = false;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        settled = true;
        void iter.return?.().catch(() => {});
        reject(new Error(timeoutSignal.aborted ? "model timed out" : "model call aborted"));
      };
      combined.addEventListener("abort", onAbort, { once: true });
      iter
        .next()
        .then(
          (r) => {
            if (settled) return; // aborted already; drop the late chunk
            resolve(r);
          },
          (err) => {
            if (!settled) reject(err);
          },
        )
        .finally(() => combined.removeEventListener("abort", onAbort));
    });
  };

  // PluginRuntime: gives hooks access to model stream, store, workspace,
  // emit, and abort signal. Plugins capture config in closures; rt provides
  // runtime capabilities at call time.
  // Two-phase: sessionEmit is bound after session creation (the session's
  // emit method doesn't exist until createOmaSession returns).
  let sessionEmit: ((event: OmaLoopEvent) => void) | null = null;
  // The workflow executor rides the SAME model stream + summarizer as the
  // main loop; subagents get the file tools only (no workflow/product tools).
  // Product budget gate (T11a): the Loop freezes its remaining daily budget
  // on the Run; the executor refuses new spawns once the completed agents'
  // usage estimate exceeds it. Advisory - the product dailyCap stays the
  // hard gate. No budget on the run = no gate.
  let workflowSpentTokens = 0;
  const workflowUsageAccum = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const workflowBudgetGate = (): { allowed: boolean; reason?: string } => {
    const budget = activeRun?.workflowBudgetTokens;
    if (budget == null) return { allowed: true };
    if (workflowSpentTokens >= budget) {
      return { allowed: false, reason: "workflow budget exhausted" };
    }
    return { allowed: true };
  };
  const workflowExecutor = createWorkflowExecutor({
    makeSubagentStream:
      (_sessionId, modelIdOverride, responseFormat) => (messages, signal, tools) =>
        streamModel(messages, signal, tools, modelIdOverride, responseFormat),
    modelId: deps.modelId,
    summarize,
    contextBudget,
    tools: fileTools,
    workspaceRoot: deps.workspaceRoot,
    workspaceAccess: deps.workspaceAccess,
    budgetGate: workflowBudgetGate,
    emit: (event) => {
      if (event.type === "workflow_agent_completed" && event.usage) {
        const usage = event.usage;
        if (typeof usage === "object") {
          const tokens = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);
          const u = usage as Record<string, unknown>;
          workflowSpentTokens +=
            tokens(u.inputTokens) +
            tokens(u.outputTokens) +
            tokens(u.cacheReadTokens) +
            tokens(u.cacheWriteTokens);
          workflowUsageAccum.inputTokens += tokens(u.inputTokens);
          workflowUsageAccum.outputTokens += tokens(u.outputTokens);
          workflowUsageAccum.cacheReadTokens += tokens(u.cacheReadTokens);
          workflowUsageAccum.cacheWriteTokens += tokens(u.cacheWriteTokens);
        }
      }
      sessionEmit?.(event);
    },
    maxConcurrent: 8,
    maxTotal: 64,
  });
  // Script runs: one workflowId shared by every agent() the script spawns.
  // The vm evaluator has no fs/network; the executor enforces caps/budget.
  const runScript = async ({
    script,
    args,
  }: {
    script: string;
    args?: unknown;
  }): Promise<{ ok: boolean; totalTokens: number; value: unknown }> => {
    const workflowId = `wf-${crypto.randomUUID()}`;
    const results: WorkflowAgentResult[] = [];
    sessionEmit?.({
      type: "workflow_started",
      workflowId,
      label: "script",
      agentCount: 0,
    });
    const { value } = await evaluateWorkflowScript({
      script,
      args,
      primitives: {
        agent: async (prompt, opts) => {
          const result = await workflowExecutor.runSubagent({
            workflowId,
            agentId: randomUUID(),
            prompt,
            ...(opts?.schema ? { schema: opts.schema } : {}),
            ...(opts?.label ? { label: opts.label } : {}),
          });
          results.push(result);
          return result;
        },
        pipeline: (items, fn) => Promise.all(items.map(fn)),
      },
    });
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
    sessionEmit?.({
      type: "workflow_completed",
      workflowId,
      ok,
      agentCount: results.length,
      totalTokens,
    });
    return { ok, totalTokens, value };
  };
  plugins.push({
    name: "workflow-tools",
    tools: createWorkflowTools({
      runWorkflow: (input) => workflowExecutor.runWorkflow(input),
      runScript,
      writeScript: (name, content) => {
        // The name is model-supplied: never treat it as a path segment
        // (a "../" escape would write outside the workspace).
        if (!isValidWorkflowName(name)) {
          throw new Error(`invalid workflow name (allowed: [a-z0-9-], max 64): ${name}`);
        }
        if (deps.workspaceAccess !== "read_write") {
          throw new Error("workflow scripts cannot be saved in a read_only workspace");
        }
        const dir = join(deps.workspaceRoot, ".oma/workflow");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.js`), content);
      },
      readScript: async (name) => {
        if (!isValidWorkflowName(name)) return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma/workflow", `${name}.js`)).text();
        } catch {
          return null;
        }
      },
      runSubagent: (spec, signal) =>
        workflowExecutor.runSubagent(
          {
            ...spec,
            workflowId: `sub-${crypto.randomUUID()}`,
            agentId: spec.label ?? "sub",
          },
          signal,
        ),
      readAgentDefinition: async (name) => {
        if (!isValidWorkflowName(name)) return null;
        // read_only workspaces have no local agent definitions — builtins only.
        if (deps.workspaceAccess !== "read_write") return null;
        try {
          return await Bun.file(join(deps.workspaceRoot, ".oma", "agents", `${name}.md`)).text();
        } catch {
          return null;
        }
      },
      listSubagents: () => workflowExecutor.listSubagents(),
      getSubagentOutput: (handle) => workflowExecutor.getSubagentOutput(handle),
      stopSubagent: (handle) => workflowExecutor.stopSubagent(handle),
    }),
  });
  const pluginRuntime: PluginRuntime = {
    streamModel: (providerId, modelId, messages, opts) =>
      deps.modelRuntime.stream(providerId, modelId, messages, opts),
    store,
    sessionId: deps.runId,
    workspaceRoot: deps.workspaceRoot,
    emit: (event) => {
      sessionEmit?.(event);
    },
    signal: new AbortController().signal,
  };

  // Hoisted so both the main session and workflow subagent sessions share it.
  async function* streamModel(
    messages: readonly Message[],
    signal?: AbortSignal,
    tools?: readonly PluginTool[],
    modelIdOverride?: string,
    responseFormat?: JsonSchema,
  ): AsyncIterable<AIMessageChunk> {
    const run = activeRun;
    if (!run) throw new Error("no active run: model unresolved");
    // 3.4: role-pinned model override resolves through the SAME catalog —
    // an unknown/absent model throws here, which is the authorization
    // boundary (no bypassing the catalog to mint expensive models).
    const modelId = modelIdOverride ?? run.model.modelId;
    const catalog = await deps.modelRuntime.getCatalog();
    const model = catalog.models.find(
      (m) => `${m.providerId}/${m.modelId}` === resolveModelAlias(modelId),
    );
    if (!model) throw new Error(`model not found: ${modelId}`);
    const timeoutSignal = AbortSignal.timeout(modelTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const reasoningEffort = (run.model as { reasoningEffort?: string }).reasoningEffort;
    const reasoningOpts =
      reasoningEffort === "none"
        ? { thinking: { type: "disabled" as const } }
        : reasoningEffort === "low" || reasoningEffort === "high" || reasoningEffort === "max"
          ? {
              thinking: { type: "adaptive" as const, display: "summarized" as const },
              effort: (reasoningEffort === "max" ? "xhigh" : reasoningEffort) as
                | "low"
                | "high"
                | "xhigh",
            }
          : {};
    const stream = deps.modelRuntime.stream(model.providerId, model.modelId, messages, {
      signal: combined,
      cacheControl: true,
      ...reasoningOpts,
      ...(responseFormat ? { responseFormat } : {}),
      tools: tools?.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    const iter = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await nextBounded(iter, combined, timeoutSignal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (!combined.aborted) await iter.return?.().catch(() => {});
    }
  }

  // pi's loop has no step cap: termination is the model's natural stop or
  // user abort. We keep a high safety ceiling (runaway-cost guard) that is
  // env-overridable; 32 was far too small for real tasks.
  const maxSteps = Number(process.env.OMA_MAX_STEPS) || 500;
  // TTSR-style stream rules from .oma/rules/*.md (workspace-scoped).
  const streamRules = loadStreamRules(deps.workspaceRoot);
  const session = createOmaSession({
    sessionId: deps.runId,
    store,
    plugins,
    pluginRuntime,
    maxSteps,
    maxForceContinues: 4,
    modelStream: streamModel,
    summarize,
    contextBudget,
    resolveModel,
    ...(streamRules.length > 0 ? { streamRules } : {}),
    ...(deps.onPersistMessages ? { onPersistMessages: deps.onPersistMessages } : {}),
  });

  // Bind the plugin runtime's emit to the session's emit (two-phase init).
  sessionEmit = (event) => session.emit(event);

  return {
    runId: deps.runId,
    store,
    session,
    summarize,
    contextBudget,
    setActiveRun(run) {
      activeRun = run;
    },
    executeWorkflow: (input) => runScript(input),
    workflowUsage: () => ({ ...workflowUsageAccum }),
    async close() {
      // 3.4 Phase 3: background subagents must not outlive the Run.
      workflowExecutor.abortAllSubagents();
      // Tear down mounted MCP clients so no child process or connection
      // outlives the Run. Each close is BOUNDED: a stuck transport (e.g. an
      // SSE socket that never answers close) must not wedge the child.
      const closeWithTimeout = (p: Promise<unknown>): Promise<unknown> =>
        Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
      const closePromises: Promise<unknown>[] = [];
      closePromises.push(closeWithTimeout(closeMounted()));
      closePromises.push(closeWithTimeout(store.close()));
      await Promise.allSettled(closePromises);
    },
  };
}

export type { AgentRunSnapshot, PluginTool, ProjectedHistoryItem };

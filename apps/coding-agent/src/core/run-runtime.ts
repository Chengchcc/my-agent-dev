import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CodingAgentLoopEvent,
  type CodingAgentSession,
  type CodingLoopInput,
  type ContextBudget,
  type ContextSummarizer,
  createCodingAgentSession,
  createInMemorySessionStore,
  type Plugin,
  type PluginRuntime,
  type PluginTool,
  type SessionStore,
} from "@my-agent-team/agent";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "@my-agent-team/agent-backend";
import { type ModelRuntime, resolveModelAlias } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import { createProgressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import { createRecapPlugin } from "@my-agent-team/plugin-recap";

import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createPortWebFetchTool,
  createPortWebSearchTool,
  createReadTool,
  createTreeTool,
  createWriteTool,
  type WebFetchPort,
  type WebSearchPort,
} from "@my-agent-team/tools-common";
import { fakeProvider } from "./fake-provider.js";

import type { ProductToolCaller } from "./product-tool-transport.js";
import { readProductToolsManifest } from "./product-tools-manifest.js";
import { loadRuntimeCatalog, registerProvidersFromCatalog } from "./runtime-catalog.js";
import { evaluateWorkflowScript } from "./workflow-evaluator.js";
import { createWorkflowExecutor, type WorkflowAgentResult } from "./workflow-executor.js";
import { createWorkflowTools } from "./workflow-tools.js";

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

/** Dependencies for ONE Run's runtime assembly. The runtime is per-Run: a
 *  fresh in-memory SessionStore and a fresh CodingAgentSession are created
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
}

export interface RunRuntime {
  readonly runId: string;
  readonly store: SessionStore;
  readonly session: CodingAgentSession;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget | undefined;
  /** Set before startLoop so modelStream resolves the run's model. */
  setActiveRun(run: AgentRunSnapshot<"coding_agent"> | null): void;
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
  if (env.CODING_AGENT_FAKE_PROVIDER === "1") {
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
    createLsTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
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
  // collide with the native table.
  tools.push(
    ...(await mountWorkspaceMcpServers(deps.workspaceRoot, new Set(tools.map((t) => t.name)))),
  );
  if (deps.webSearch) {
    fileTools.push(createPortWebSearchTool(deps.webSearch) as unknown as PluginTool);
  }
  if (deps.webFetch) {
    fileTools.push(createPortWebFetchTool(deps.webFetch) as unknown as PluginTool);
  }

  const nativeToolsPlugin: Plugin = { name: "native-tools", tools: fileTools };
  const plugins: Plugin[] = [
    nativeToolsPlugin,
    createRecapPlugin({
      recapModelRef: { providerId: "", modelId: "" },
      enabled: process.env.CODING_AGENT_RECAP_ENABLED === "1",
    }),
    createProgressiveSkillPlugin({ roots: deps.skillRoots }),
  ];

  // Product Tools are resolved PER RUN from the AgentRunSnapshot manifest:
  // resolveTools builds the tool table from input.run.productTools + the run's
  // identity (runId + metadata). Every call carries identity + abort +
  // timeout through the transport.
  const { buildProductTools } = await import("./product-tool-transport.js");
  // Direct MCP client per ENTRYPOINT; the tool NAME is the MCP tool name.
  // entrypoint is a structured URI: `sse:<url>` or `stdio:<executable>` (a
  // single executable path - never shell-split). Identity is injected per
  // call; timeout/abort close the transport so a canceled call cannot produce
  // a late side effect.
  const clients = new Map<string, unknown>();
  const caller: ProductToolCaller = {
    async callTool(p) {
      let client = clients.get(p.entrypoint);
      if (!client) {
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        let transport: unknown;
        if (p.entrypoint.startsWith("sse:")) {
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          // Service-token auth for remote Product Tools endpoints: the token
          // is process configuration (CODING_AGENT_PRODUCT_TOOL_TOKEN), never
          // part of the entrypoint URI or MCP arguments.
          const token = process.env.CODING_AGENT_PRODUCT_TOOL_TOKEN;
          transport = new SSEClientTransport(
            new URL(p.entrypoint.slice(4)),
            token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
          );
        } else if (p.entrypoint.startsWith("stdio:")) {
          const { StdioClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/stdio.js"
          );
          transport = new StdioClientTransport({
            command: p.entrypoint.slice(6),
            args: [],
          });
        } else {
          throw new Error(
            `invalid product tool entrypoint (expected sse:<url> or stdio:<executable>): ${p.entrypoint}`,
          );
        }
        const c = new Client({ name: "coding-agent", version: "0.1.0" }, { capabilities: {} });
        await c.connect(transport as never);
        client = c;
        clients.set(p.entrypoint, c);
      }
      const mcpClient = client as {
        callTool(params: {
          name: string;
          arguments?: unknown;
          _meta?: { identity: unknown };
        }): Promise<{ content: unknown }>;
        close(): Promise<void>;
      };
      const cancel = (): void => {
        clients.delete(p.entrypoint);
        void mcpClient.close().catch(() => {});
      };
      p.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const res = await mcpClient.callTool({
          name: p.name,
          arguments: p.arguments,
          _meta: { identity: p.identity },
        });
        return { content: res.content };
      } catch (err) {
        cancel();
        throw err;
      } finally {
        p.signal?.removeEventListener("abort", cancel);
      }
    },
  };
  const resolveTools = async (input: CodingLoopInput): Promise<readonly PluginTool[]> => {
    // ADR 0003 decision 6: the manifest lives in the workspace files
    // (.agent/product-tools.json, written by the workspace bridge), never
    // in the run input.
    const manifest = readProductToolsManifest(input.workspace.root);
    if (manifest.length === 0) return [];
    // Per-call timeout: default 30s, overridable via env so the real MCP
    // timeout path is testable without waiting 30s.
    const rawTimeout = process.env.CODING_AGENT_PRODUCT_TOOL_TIMEOUT_MS;
    const timeoutMs = rawTimeout ? Number(rawTimeout) || 30_000 : 30_000;
    const tools = buildProductTools(manifest, {
      identity: {
        runId: input.run.runId,
        conversationId: input.metadata.conversationId,
        agentMemberId: input.metadata.agentMemberId,
        branchId: input.metadata.branchId,
      },
      caller,
      timeoutMs,
    }) as unknown as PluginTool[];
    // Mark them so the loop's tool events carry kind="product" and consumers
    // map them to product_tool_started/completed (not native_tool_*).
    for (const t of tools) {
      (t as PluginTool & { kind?: string }).kind = "product";
    }
    return tools;
  };

  let activeRun: AgentRunSnapshot<"coding_agent"> | null = null;

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
    const raw = process.env.CODING_AGENT_MODEL_TIMEOUT_MS;
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
  // emit method doesn't exist until createCodingAgentSession returns).
  let sessionEmit: ((event: CodingAgentLoopEvent) => void) | null = null;
  // The workflow executor rides the SAME model stream + summarizer as the
  // main loop; subagents get the file tools only (no workflow/product tools).
  // Product budget gate (T11a): the Loop freezes its remaining daily budget
  // on the Run; the executor refuses new spawns once the completed agents'
  // usage estimate exceeds it. Advisory - the product dailyCap stays the
  // hard gate. No budget on the run = no gate.
  let workflowSpentTokens = 0;
  const workflowBudgetGate = (): { allowed: boolean; reason?: string } => {
    const budget = activeRun?.workflowBudgetTokens;
    if (budget == null) return { allowed: true };
    if (workflowSpentTokens >= budget) {
      return { allowed: false, reason: "workflow budget exhausted" };
    }
    return { allowed: true };
  };
  const workflowExecutor = createWorkflowExecutor({
    makeSubagentStream: () => streamModel,
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
          workflowSpentTokens +=
            tokens((usage as Record<string, unknown>).inputTokens) +
            tokens((usage as Record<string, unknown>).outputTokens) +
            tokens((usage as Record<string, unknown>).cacheReadTokens) +
            tokens((usage as Record<string, unknown>).cacheWriteTokens);
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
    const workflowId = `wf-${Date.now().toString(36)}`;
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
        const dir = join(deps.workspaceRoot, ".workflows");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.js`), content);
      },
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
  ): AsyncIterable<AIMessageChunk> {
    const run = activeRun;
    if (!run) throw new Error("no active run: model unresolved");
    const catalog = await deps.modelRuntime.getCatalog();
    const model = catalog.models.find(
      (m) => `${m.providerId}/${m.modelId}` === resolveModelAlias(run.model.modelId),
    );
    if (!model) throw new Error(`model not found: ${run.model.modelId}`);
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

  const session = createCodingAgentSession({
    sessionId: deps.runId,
    store,
    plugins,
    pluginRuntime,
    maxSteps: 32,
    maxForceContinues: 4,
    modelStream: streamModel,
    summarize,
    contextBudget,
    resolveModel,
    resolveTools,
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
    async close() {
      // Tear down every MCP client (Product Tool transports) so no child
      // process or connection outlives the Run. Each close is BOUNDED: a
      // stuck transport (e.g. an SSE socket that never answers close) must
      // not wedge the child process.
      const closeWithTimeout = (p: Promise<unknown>): Promise<unknown> =>
        Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
      const closePromises: Promise<unknown>[] = [];
      for (const [entrypoint, c] of clients) {
        clients.delete(entrypoint);
        closePromises.push(
          closeWithTimeout(
            (c as { close?: () => Promise<void> }).close?.().catch(() => {}) ?? Promise.resolve(),
          ),
        );
      }
      closePromises.push(closeWithTimeout(store.close()));
      await Promise.allSettled(closePromises);
    },
  };
}

export type { AgentRunSnapshot, PluginTool, ProjectedHistoryItem };

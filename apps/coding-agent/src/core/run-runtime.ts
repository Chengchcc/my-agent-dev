import {
  type CodingAgentSession,
  type CodingLoopInput,
  type ContextBudget,
  type ContextSummarizer,
  createCodingAgentSession,
  createInMemorySessionStore,
  type Plugin,
  type PluginTool,
  type SessionStore,
} from "@my-agent-team/agent";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "@my-agent-team/agent-backend";
import { anthropicProvider, type ModelRuntime } from "@my-agent-team/ai";
import type { Message } from "@my-agent-team/message";
import { createProgressiveSkillPlugin } from "@my-agent-team/plugin-progressive-skill";
import { createTodoPlugin } from "@my-agent-team/plugin-todo";
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
  } else if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    runtime.registerProvider(anthropicProvider({ baseUrl: env.ANTHROPIC_BASE_URL ?? undefined }));
  }
}

/** Build the complete Runtime assembly for exactly ONE Run. The Run's
 *  in-memory SessionStore is created here (never shared with other Runs);
 *  the model is resolved per run from the AgentRunSnapshot. */
export async function assembleRunRuntime(deps: RunRuntimeDeps): Promise<RunRuntime> {
  const store = createInMemorySessionStore();
  const tools: PluginTool[] = [
    createReadTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createLsTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createTreeTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createGlobTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
    createGrepTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
  ];
  if (deps.workspaceAccess === "read_write") {
    tools.push(createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    tools.push(createEditTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool);
    tools.push(createBashTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool);
  }
  if (deps.webSearch) {
    tools.push(createPortWebSearchTool(deps.webSearch) as unknown as PluginTool);
  }
  if (deps.webFetch) {
    tools.push(createPortWebFetchTool(deps.webFetch) as unknown as PluginTool);
  }

  const nativeToolsPlugin: Plugin = { name: "native-tools", tools };
  const plugins: Plugin[] = [
    nativeToolsPlugin,
    createTodoPlugin({ sessionId: deps.runId, store }),
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
    const manifest = input.run.productTools;
    if (!manifest || manifest.length === 0) return [];
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
    const model = catalog.models.find((m) => `${m.providerId}/${m.modelId}` === modelId);
    if (!model) throw new Error(`model not found: ${modelId}`);
    return { provider: model.providerId, id: model.modelId };
  };

  // Summarizer: call the summary model through ModelRuntime with full
  // Message[] input and AbortSignal support. No placeholder summaries.
  const summarize: ContextSummarizer = async (messages, signal) => {
    const catalog = await deps.modelRuntime.getCatalog();
    const model = catalog.models[0];
    if (!model) throw new Error("no models available for summarization");
    const summaryMessages: Message[] = [
      {
        role: "system",
        text: "Summarize the following conversation messages, preserving tool calls, results, decisions and next steps.",
      },
      ...messages,
    ];
    let text = "";
    for await (const chunk of deps.modelRuntime.stream(
      model.providerId,
      model.modelId,
      summaryMessages,
      { signal },
    )) {
      if (signal?.aborted) break;
      if (chunk.delta?.type === "text") text += chunk.delta.text;
    }
    if (signal?.aborted) throw new Error("summarizer aborted");
    return text || "[empty summary]";
  };

  // ContextBudget from the model catalog's context window.
  // ponytail: budget is fixed at run assembly from the catalog's first
  // model; switching models on later runs keeps the first window. A per-run
  // budget would need a session API to update ContextBudget - add when
  // multi-model runs actually run.
  const primaryModel = (await deps.modelRuntime.getCatalog()).models[0];
  const contextBudget: ContextBudget | undefined = primaryModel
    ? {
        estimate: (m) => Math.ceil(JSON.stringify(m).length / 4),
        limit: primaryModel.contextWindow,
        triggerRatio: 0.7,
      }
    : undefined;

  const session = createCodingAgentSession({
    sessionId: deps.runId,
    store,
    plugins,
    maxSteps: 32,
    maxForceContinues: 4,
    modelStream: async function* (messages, signal) {
      const run = activeRun;
      if (!run) throw new Error("no active run: model unresolved");
      const catalog = await deps.modelRuntime.getCatalog();
      const model = catalog.models.find(
        (m) => `${m.providerId}/${m.modelId}` === run.model.modelId,
      );
      if (!model) throw new Error(`model not found: ${run.model.modelId}`);
      yield* deps.modelRuntime.stream(model.providerId, model.modelId, messages, { signal });
    },
    summarize,
    contextBudget,
    resolveModel,
    resolveTools,
  });

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

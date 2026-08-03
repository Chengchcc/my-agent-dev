import { mkdirSync } from "node:fs";
import {
  type CodingAgentSession,
  type ContextBudget,
  type ContextSummarizer,
  createCodingAgentSession,
  createSqliteSessionStore,
  type Plugin,
  type PluginTool,
  renderLoopMeta,
  type SessionStore,
} from "@my-agent-team/agent";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";
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

/** Dependencies the daemon injects into a Worker's Runtime assembly. */
export interface WorkerRuntimeDeps {
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly backendSessionId: string;
  readonly modelRuntime: ModelRuntime;
  readonly skillRoots: readonly string[];
  readonly webSearch?: WebSearchPort;
  readonly webFetch?: WebFetchPort;
}

export interface WorkerRuntime {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly session: CodingAgentSession;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget | undefined;
  /** Set before each start_run/send so modelStream resolves the run's model. */
  setActiveRun(run: AgentRunSnapshot<"coding_agent"> | null): void;
}

/** Build the complete Runtime assembly for exactly one session. The model is
 *  resolved per run: `setActiveRun` installs the AgentRunSnapshot model before
 *  the loop starts. */
export async function assembleWorkerRuntime(deps: WorkerRuntimeDeps): Promise<WorkerRuntime> {
  const sessionsDir = `${deps.dataDir}/sessions`;
  mkdirSync(sessionsDir, { recursive: true });
  const store = createSqliteSessionStore(`${sessionsDir}/${deps.backendSessionId}.sqlite`);

  const tools: PluginTool[] = [
    createReadTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createWriteTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createEditTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createLsTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createTreeTool({ cwd: deps.workspaceRoot }) as unknown as PluginTool,
    createBashTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
    createGlobTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
    createGrepTool({ workspaceRoot: deps.workspaceRoot }) as unknown as PluginTool,
  ];
  if (deps.webSearch) {
    tools.push(createPortWebSearchTool(deps.webSearch) as unknown as PluginTool);
  }
  if (deps.webFetch) {
    tools.push(createPortWebFetchTool(deps.webFetch) as unknown as PluginTool);
  }

  const nativeToolsPlugin: Plugin = { name: "native-tools", tools };
  const plugins: Plugin[] = [
    nativeToolsPlugin,
    createTodoPlugin({ sessionId: deps.backendSessionId, store }),
    createProgressiveSkillPlugin({ roots: deps.skillRoots }),
  ];

  let activeRun: AgentRunSnapshot<"coding_agent"> | null = null;

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

  // ContextBudget from the model catalog's context window
  const primaryModel = (await deps.modelRuntime.getCatalog()).models[0];
  const contextBudget: ContextBudget | undefined = primaryModel
    ? {
        estimate: (m) => Math.ceil(JSON.stringify(m).length / 4),
        limit: primaryModel.contextWindow,
        triggerRatio: 0.7,
      }
    : undefined;

  const session = createCodingAgentSession({
    sessionId: deps.backendSessionId,
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
  });

  return {
    sessionId: deps.backendSessionId,
    store,
    session,
    summarize,
    contextBudget,
    setActiveRun(run) {
      activeRun = run;
    },
  };
}

/** Build the Meta text for a loop input from plugins + runtime facts. */
export function renderMetaForRun(
  plugins: readonly Plugin[],
  workspaceRoot: string,
  modelId: string,
): string {
  return renderLoopMeta({
    plugins,
    workspace: { root: workspaceRoot },
    model: {
      id: modelId,
      name: modelId,
      provider: "coding_agent",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
  });
}

export type { AgentRunSnapshot, PluginTool, ProjectedHistoryItem };

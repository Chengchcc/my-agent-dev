import type {
  AgentRunSnapshot,
  BackendInputMessage,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import type { SessionStore } from "../persistence/session-store.js";
import type { CodingLoopInput } from "./loop-input.js";

process.env.OMA_TITLE_ENABLED = "0";

export type StoreFactory = (sid: string) => SessionStore;
export type ReopenFactory = (sid: string) => SessionStore;

export function createSession(store: SessionStore, sid: string) {
  return store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Fake model that yields text then stops. */
export function textModel(text: string) {
  return async function* (): AsyncIterable<AIMessageChunk> {
    yield { delta: { type: "text", text } };
  };
}

/** Fake model that throws before producing any output (zero-output failure). */
export function throwingModel(err: unknown): () => AsyncIterable<AIMessageChunk> {
  return () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => Promise.reject(err) };
    },
  });
}

export function echoTool(name = "echo") {
  return {
    name,
    description: "Echo input",
    async execute(args: Readonly<Record<string, unknown>>) {
      return { echoed: args } as unknown as Readonly<Record<string, unknown>>;
    },
  };
}

/** Deterministic fake summarizer for tests. */
export const fakeSummarize = async <T>(messages: readonly T[]): Promise<string> => {
  return `[Summary of ${messages.length} messages]`;
};

/** PluginTool-shaped static tool. */
export function staticTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true };
    },
  };
}

export const LOOP_RUN: AgentRunSnapshot<"oma"> = {
  runId: "loop-run",
  model: { backendKind: "oma", modelId: "test-1" },
  configRevision: 1,
};
export const LOOP_WS: WorkspaceBinding = { root: "/ws", access: "read_write" };
export const LOOP_META = { conversationId: "c", agentId: "m", branchId: "b", productRevision: 1 };

/** Build a CodingLoopInput for tests. The Session renders Meta internally, so
 *  callers only provide the driving input (and optional history/run overrides). */
export function loopInput(over: {
  message: string;
  history?: CodingLoopInput["history"];
  run?: AgentRunSnapshot<"oma">;
}): CodingLoopInput {
  const input: BackendInputMessage = {
    inputId: "ti",
    message: { role: "user", text: over.message },
  };
  return {
    history: over.history ?? [],
    input,
    run: over.run ?? LOOP_RUN,
    workspace: LOOP_WS,
    metadata: LOOP_META,
  };
}

/** In-memory store factory + reopen factory (mirrors the previous harness
 *  bottom call; in-memory has no persistence boundary to cross). */
export function createMemoryStores(): {
  storeFactory: StoreFactory;
  reopenFactory: ReopenFactory;
} {
  const stores = new Map<string, SessionStore>();
  return {
    storeFactory: (sid) => {
      const store = createInMemorySessionStore();
      stores.set(sid, store);
      return store;
    },
    reopenFactory: (sid) => stores.get(sid)!,
  };
}

import { describe, expect, test } from "bun:test";
import type {
  AgentRunSnapshot,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import type { ContextBudget } from "./agent-loop.js";
import { createOmaSession } from "./agent-loop.js";
import type { CodingLoopInput } from "./loop-input.js";
import type { Plugin } from "./plugin.js";

// Title generation performs an extra ephemeral model call; keep counts
// deterministic.
process.env.OMA_TITLE_ENABLED = "0";

const LOOP_RUN: AgentRunSnapshot<"oma"> = {
  runId: "ovf-run",
  model: { backendKind: "oma", modelId: "test-1" },
  configRevision: 1,
};
const LOOP_WS: WorkspaceBinding = { root: "/ws", access: "read_write" };
const LOOP_META = { conversationId: "c", agentId: "m", branchId: "b", productRevision: 1 };

function loopInput(message: string, history?: CodingLoopInput["history"]): CodingLoopInput {
  return {
    history: history ?? [],
    input: { inputId: "ti", message: { role: "user", text: message } },
    run: LOOP_RUN,
    workspace: LOOP_WS,
    metadata: LOOP_META,
  };
}

async function freshStore(sid: string) {
  const store = createInMemorySessionStore();
  await store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return store;
}

const charsPer4 = (m: { text?: string }): number => Math.ceil((m.text?.length ?? 0) / 4) + 4;

const bigToolPlugin: Plugin = {
  name: "test-tools",
  tools: [
    {
      name: "big",
      description: "returns a big result",
      async execute() {
        return { content: "y".repeat(4000) };
      },
    },
  ],
};

describe("agent loop context handling (oh-my-pi absorption)", () => {
  test("silent overflow (zai-style) triggers one-shot compaction and same-turn retry", async () => {
    const store = await freshStore("ovf-silent");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-silent",
      store,
      plugins: [],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 1000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          // Silent overflow: the provider accepted an oversized request.
          yield { usage: { input: 5000, output: 3, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "text", text: "truncated garbage" } };
          yield { stopReason: "end_turn" };
          return;
        }
        yield { usage: { input: 50, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "recovered" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hello"));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(events).toContain("compaction_start");
    expect(events).toContain("compaction_end");
    // The overflowed attempt was discarded pre-persistence; only the retry
    // survives in the canonical sequence.
    expect(result.messages?.at(-1)).toMatchObject({ text: "recovered" });
    expect(JSON.stringify(result.messages)).not.toContain("truncated garbage");
  });

  test("usage anchor suppresses threshold compaction when real usage is small", async () => {
    // Pre-boundary history estimates to ~2000 chars/4 tokens; the anchor
    // (call 1's real usage: 1005) plus the post-boundary delta must stay
    // under the 2800 threshold — while full per-message estimation
    // (~2062 + ~1018 for the giant tool result) would cross it.
    const history: ProjectedHistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(1000) },
    }));
    const store = await freshStore("ovf-anchor");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-anchor",
      store,
      plugins: [bigToolPlugin],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 4000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          yield { usage: { input: 1000, output: 5, cacheRead: 0, cacheCreate: 0 } };
          yield { delta: { type: "tool_use", id: "t1", name: "big" } };
          return;
        }
        yield { usage: { input: 1200, output: 5, cacheRead: 0, cacheCreate: 0 } };
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(events).not.toContain("compaction_start");
  });

  test("control: without usage the same shape crosses the threshold and compacts", async () => {
    const history: ProjectedHistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      productEntryId: `h${i}`,
      message: { role: i % 2 ? "assistant" : "user", text: "x".repeat(1000) },
    }));
    const store = await freshStore("ovf-ctrl");
    const events: string[] = [];
    let calls = 0;
    const session = createOmaSession({
      sessionId: "ovf-ctrl",
      store,
      plugins: [bigToolPlugin],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      contextBudget: {
        estimate: charsPer4,
        limit: 4000,
        triggerRatio: 0.7,
      } satisfies ContextBudget,
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          // No usage chunks: no anchor, full per-message estimation.
          yield { delta: { type: "tool_use", id: "t1", name: "big" } };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    session.onEvent((e) => {
      events.push(e.type);
    });
    const result = await session.startLoop(loopInput("hi", history));
    expect(result.status).toBe("completed");
    expect(events).toContain("compaction_start");
  });

  test("steer drain emits queue_update with the drained user texts", async () => {
    const store = await freshStore("steer-drain");
    const queueEvents: Array<{ drained?: readonly string[] }> = [];
    let loopRef: ReturnType<typeof createOmaSession> | null = null;
    const gateTool = {
      name: "gate",
      description: "steers the loop mid-execution",
      execute() {
        loopRef?.steer({ inputId: "s1", message: { role: "user", text: "correction" } });
        return Promise.resolve({ ok: true });
      },
    };
    let calls = 0;
    const session = createOmaSession({
      sessionId: "steer-drain",
      store,
      plugins: [{ name: "t", tools: [gateTool] }],
      maxSteps: 4,
      maxForceContinues: 0,
      summarize: async () => "[summary]",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        calls++;
        if (calls === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "gate" } };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    loopRef = session;
    session.onEvent((e) => {
      if (e.type === "queue_update") queueEvents.push({ drained: e.drained });
    });
    const result = await session.startLoop(loopInput("go"));
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    // pi's message_start(user) signal: the surface learns the steer was
    // actually injected, with its text.
    expect(queueEvents).toEqual([{ drained: ["correction"] }]);
    const snap = await store.open("steer-drain");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
  });
});

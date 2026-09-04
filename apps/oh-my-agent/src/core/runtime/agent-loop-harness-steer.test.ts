import { describe, expect, test } from "bun:test";
import { createOmaSession } from "./agent-loop.js";
import {
  createMemoryStores,
  createSession,
  fakeSummarize,
  loopInput,
  textModel,
} from "./coding-agent-harness.fixture.js";
import type { Plugin } from "./plugin.js";

const { storeFactory } = createMemoryStores();

describe("agent loop harness steer", () => {
  test("8. steer injects at safe boundary without new Meta", async () => {
    const store = storeFactory("h8");
    await createSession(store, "h8");
    let turn = 0;
    let loopRef: ReturnType<typeof createOmaSession> | null = null;
    const steerTool = {
      name: "steer_from_tool",
      description: "Steer the loop",
      async execute() {
        loopRef?.steer({ inputId: "ti", message: { role: "user", text: "steer-me" } });
        return { ok: true };
      },
    };
    const plugin: Plugin = { name: "test", tools: [steerTool] };
    const loop = createOmaSession({
      sessionId: "h8",
      store,
      plugins: [plugin],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        turn++;
        if (turn === 1) {
          // First turn: ask for the tool that steers mid-execution
          yield { delta: { type: "tool_use", id: "tc-1", name: "steer_from_tool" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    loopRef = loop;
    await loop.startLoop(loopInput({ message: "go" }));
    const snap = await store.open("h8");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
    // One Meta for the whole loop; steer never adds one
    expect(sources.filter((s) => s === "meta")).toHaveLength(1);
  });

  test("8a. idle steer is rejected and does not enter the loop", async () => {
    const store = storeFactory("h8a");
    await createSession(store, "h8a");
    const loop = createOmaSession({
      sessionId: "h8a",
      store,
      plugins: [],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    // steer before the loop starts -> rejected
    expect(() =>
      loop.steer({ inputId: "ti", message: { role: "user", text: "before run" } }),
    ).toThrow(/remaining turn capacity|active loop/);
    await loop.startLoop(loopInput({ message: "go" }));
    expect(loop.status).toBe("completed");
    const snap = await store.open("h8a");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).not.toContain("steer");
  });

  test("8b. late steer does not leak into follow-up", async () => {
    const store = storeFactory("h8b");
    await createSession(store, "h8b");
    const loop = createOmaSession({
      sessionId: "h8b",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.startLoop(loopInput({ message: "p1" }));
    expect(loop.status).toBe("completed");
    // After the loop ended, steer is rejected (not running)
    expect(() => loop.steer({ inputId: "ti", message: { role: "user", text: "late" } })).toThrow(
      /remaining turn capacity|active loop/,
    );
    // Follow-up must not contain the late steer
    await loop.startFollowUp(loopInput({ message: "p2" }));
    const snap = await store.open("h8b");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).not.toContain("steer");
    // Two metas (one per loop), no steer
    expect(sources.filter((s) => s === "meta")).toHaveLength(2);
  });

  test("8c. accepted late steer is delivered even if model turn ends naturally", async () => {
    const store = storeFactory("h8c");
    await createSession(store, "h8c");
    const { promise: modelStarted, resolve: modelResolve } = Promise.withResolvers<void>();
    const loop = createOmaSession({
      sessionId: "h8c",
      store,
      plugins: [],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        modelResolve();
        yield { delta: { type: "text", text: "done" } };
      },
    });
    const started = loop.startLoop(loopInput({ message: "go" }));
    // Wait for the model turn to start, then steer while it's running.
    await modelStarted;
    loop.steer({ inputId: "ti", message: { role: "user", text: "accepted-but-late" } });
    await started;
    expect(loop.status).toBe("completed");
    // The late steer must appear in the store, not be silently dropped
    const snap = await store.open("h8c");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
  });

  test("8d. setup failure settles to failed with agent_end", async () => {
    const store = storeFactory("h8d");
    // Do NOT create the session — appendBatch will throw "not found"
    const loop = createOmaSession({
      sessionId: "h8d",
      store,
      plugins: [],
      maxSteps: 3,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    const events: string[] = [];
    loop.onEvent((e) => {
      events.push(e.type);
    });
    await loop.startLoop(loopInput({ message: "go" }));
    expect(loop.status).toBe("failed");
    // agent_start emitted, then agent_end (never stuck at running)
    expect(events[0]).toBe("agent_start");
    expect(events[events.length - 1]).toBe("agent_end");
  });

  test("8e. terminate tool does not discard accepted steer", async () => {
    const store = storeFactory("h8e");
    await createSession(store, "h8e");
    const { promise: _toolStarted, resolve: toolStartedResolve } = Promise.withResolvers<void>();
    let loopRef: ReturnType<typeof createOmaSession> | null = null;
    const finishTool = {
      name: "finish",
      description: "Terminate",
      async execute() {
        toolStartedResolve();
        // Steer arrives during tool execution
        loopRef?.steer({ inputId: "ti", message: { role: "user", text: "late-steer" } });
        return { terminate: true };
      },
    };
    const plugin: Plugin = { name: "test", tools: [finishTool] };
    const loop = createOmaSession({
      sessionId: "h8e",
      store,
      plugins: [plugin],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        yield { delta: { type: "tool_use", id: "f", name: "finish" } };
        yield { stopReason: "tool_use" };
      },
    });
    loopRef = loop;
    await loop.startLoop(loopInput({ message: "go" }));
    // Steer must be persisted despite terminate hint
    const snap = await store.open("h8e");
    const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
    expect(sources).toContain("steer");
  });

  test("8f. compaction summarizer receives full Message objects with tool blocks", async () => {
    const store = storeFactory("h8f");
    await createSession(store, "h8f");
    let receivedMessages: unknown[] = [];
    const summaryWithToolBlocks = async (messages: readonly unknown[]) => {
      receivedMessages = [...messages];
      return `[Summary with ${messages.length} messages]`;
    };
    // Seed 10 entries: tool exchange at positions 2-3, enough trailing msgs
    // so the token-aware cut keeps both fully covered (no pair adjustment).
    await store.appendBatch("h8f", {
      entries: [
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "msg 0" },
          createdAt: 1,
        },
      ],
    });
    await store.appendBatch("h8f", {
      entries: [
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "msg 1" },
          createdAt: 2,
        },
      ],
    });
    await store.appendBatch("h8f", {
      entries: [
        {
          type: "message",
          role: "assistant",
          source: "assistant",
          message: {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "weather" } }],
          },
          createdAt: 3,
        },
      ],
    });
    await store.appendBatch("h8f", {
      entries: [
        {
          type: "message",
          role: "tool",
          source: "tool_result",
          message: {
            role: "tool",
            text: "sunny",
            blocks: [{ type: "tool_result", tool_use_id: "t1", content: "sunny" }],
          },
          createdAt: 4,
        },
      ],
    });
    for (let i = 4; i < 10; i++) {
      await store.appendBatch("h8f", {
        entries: [
          {
            type: "message",
            role: "user",
            source: "prompt",
            message: { role: "user", text: `msg ${i}` },
            createdAt: 5 + i,
          },
        ],
      });
    }
    const loop = createOmaSession({
      sessionId: "h8f",
      store,
      plugins: [],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: summaryWithToolBlocks,
      contextBudget: {
        estimate: (m: { text?: string }) => Math.ceil((m.text ?? "").length / 4),
        limit: 10,
        triggerRatio: 0.5,
      },
      modelStream: async function* () {
        yield { delta: { type: "text", text: "done" } };
      },
    });
    await loop.startLoop(loopInput({ message: "go" }));
    // Summarizer received Message objects, not just text strings
    expect(receivedMessages.length).toBeGreaterThan(0);
    const firstMsg = receivedMessages[0] as { role?: string; blocks?: unknown[] };
    expect(firstMsg).toBeTruthy();
    // At least one covered message had blocks (tool exchange)
    const hasBlocks = receivedMessages.some(
      (m) =>
        (m as { blocks?: unknown[] }).blocks && (m as { blocks?: unknown[] }).blocks!.length > 0,
    );
    expect(hasBlocks).toBe(true);
  });

  test("8g. stop during compaction summarizer cancels and writes no entry", async () => {
    const store = storeFactory("h8g");
    await createSession(store, "h8g");
    // Seed enough messages to trigger compaction
    for (let i = 0; i < 6; i++) {
      await store.appendBatch("h8g", {
        entries: [
          {
            type: "message",
            role: "user",
            source: "prompt",
            message: { role: "user", text: `seed ${i}` },
            createdAt: Date.now(),
          },
        ],
      });
    }
    let signalSeen = false;
    const { promise: summarizerStarted, resolve: summarizerResolve } =
      Promise.withResolvers<void>();
    const blockingSummarizer = async (_msgs: readonly unknown[], signal?: AbortSignal) => {
      signalSeen = !!signal;
      summarizerResolve();
      if (signal) {
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      }
      return "summary";
    };
    const loop = createOmaSession({
      sessionId: "h8g",
      store,
      plugins: [],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: blockingSummarizer,
      contextBudget: {
        estimate: (m: { text?: string }) => Math.ceil((m.text ?? "").length / 4),
        limit: 10,
        triggerRatio: 0.5,
      },
      modelStream: async function* () {
        yield { delta: { type: "text", text: "done" } };
      },
    });
    const started = loop.startLoop(loopInput({ message: "go" }));
    await summarizerStarted;
    loop.stop();
    await started;
    expect(signalSeen).toBe(true);
    expect(loop.status).toBe("stopped");
    // No CompactionEntry written (aborted before write)
    const snap = await store.open("h8g");
    expect(snap.entries.some((e) => e.type === "compaction")).toBe(false);
  });

  test("9. follow-up creates a new loop with new Meta", async () => {
    const store = storeFactory("h9");
    await createSession(store, "h9");
    const loop = createOmaSession({
      sessionId: "h9",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.startLoop(loopInput({ message: "first" }));
    await loop.startFollowUp(loopInput({ message: "second" }));
    const snap = await store.open("h9");
    const metas = snap.entries.filter((e) => e.type === "message" && e.source === "meta");
    // Meta is rendered internally per loop (not a passed string); each loop
    // produces exactly one, distinct from the prompt.
    expect(metas).toHaveLength(2);
    for (const m of metas) {
      expect((m as { message: { text: string } }).message.text).toContain("<system-reminder>");
    }
  });

  test("9b. resolveTools merges per-run tools into the table (not frozen)", async () => {
    const store = storeFactory("h9b");
    await createSession(store, "h9b");
    let ptAExecutions = 0;
    let resolveCalls = 0;
    const loop = createOmaSession({
      sessionId: "h9b",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        yield { delta: { type: "tool_use", id: "tc-1", name: "pt-a" } };
        yield { stopReason: "tool_use" };
      },
      // The tool manifest is no longer part of the run input (ADR 0003:
      // workspace files carry it); the seam itself must still be invoked
      // per runLoop and its tools scoped to that run.
      resolveTools: async () => {
        resolveCalls++;
        const name = resolveCalls === 1 ? "pt-a" : "pt-b";
        return [
          {
            name,
            description: name,
            inputSchema: { type: "object" },
            async execute() {
              if (name === "pt-a") ptAExecutions++;
              return { ok: true };
            },
          },
        ];
      },
    });
    // Run 1: the seam supplies pt-a -> it exists and executes.
    await loop.startLoop(loopInput({ message: "first" }));
    expect(ptAExecutions).toBe(2); // one per step in run 1 (maxSteps 2)
    // Run 2: the seam now supplies pt-b -> pt-a is gone from the table;
    // the model's pt-a call resolves to is_error (unknown tool), so pt-a's
    // execute is NOT invoked again. Tools are per-Run, not frozen.
    await loop.startFollowUp(loopInput({ message: "second" }));
    expect(ptAExecutions).toBe(2); // pt-a NOT executed in run 2
    const snap = await store.open("h9b");

    const results = snap.entries.filter(
      (e) => e.type === "message" && (e as { source?: string }).source === "tool_result",
    );
    // Run 2's pt-a call produced an is_error tool_result (tool not found).
    const run2Result = results[results.length - 1] as {
      message: { blocks?: Array<{ is_error?: boolean }> };
    };
    expect(run2Result?.message.blocks?.[0]?.is_error).toBe(true);
  });
});

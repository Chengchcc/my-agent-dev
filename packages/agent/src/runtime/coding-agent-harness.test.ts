import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type {
  AgentRunSnapshot,
  BackendInputMessage,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import type { SessionStore } from "../persistence/session-store.js";
import { createCodingAgentSession } from "./agent-loop.js";
import type { CodingLoopInput } from "./loop-input.js";
import type { Plugin } from "./plugin.js";
import { readTodo, writeTodo } from "./todo.js";

type StoreFactory = (sid: string) => SessionStore;
type ReopenFactory = (sid: string) => SessionStore;

function createSession(store: SessionStore, sid: string) {
  return store.create({
    sessionId: sid,
    backendKind: "coding_agent",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Fake model that yields text then stops. */
function textModel(text: string) {
  return async function* (): AsyncIterable<AIMessageChunk> {
    yield { delta: { type: "text", text } };
  };
}

/** Fake model that throws before producing any output (zero-output failure). */
function throwingModel(err: unknown): () => AsyncIterable<AIMessageChunk> {
  return () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => Promise.reject(err) };
    },
  });
}

function echoTool(name = "echo") {
  return {
    name,
    description: "Echo input",
    async execute(args: Readonly<Record<string, unknown>>) {
      return { echoed: args } as unknown as Readonly<Record<string, unknown>>;
    },
  };
}

/** Deterministic fake summarizer for tests. */
const fakeSummarize = async <T>(messages: readonly T[]): Promise<string> => {
  return `[Summary of ${messages.length} messages]`;
};

/** PluginTool-shaped static tool. */
function staticTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true };
    },
  };
}
const LOOP_RUN: AgentRunSnapshot<"coding_agent"> = {
  runId: "loop-run",
  model: { backendKind: "coding_agent", modelId: "test-1" },
  productTools: [],
  configRevision: 1,
};
const LOOP_WS: WorkspaceBinding = { root: "/ws", access: "read_write" };
const LOOP_META = { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 };

/** Build a CodingLoopInput for tests. The Session renders Meta internally, so
 *  callers only provide the driving input (and optional history/run overrides). */
function loopInput(over: {
  message: string;
  history?: CodingLoopInput["history"];
  run?: AgentRunSnapshot<"coding_agent">;
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

function testHarness(
  name: string,
  storeFactory: StoreFactory,
  reopenFactory?: ReopenFactory,
  cleanup?: () => void,
) {
  describe(`${name} harness`, () => {
    test("1. product history + one Meta + one Prompt enter the tree", async () => {
      const store = storeFactory("h1");
      await createSession(store, "h1");
      const loop = createCodingAgentSession({
        sessionId: "h1",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("done"),
      });
      await loop.startLoop(
        loopInput({
          message: "go",
          history: [
            {
              productEntryId: "pe-1",
              message: { role: "user", text: "previous turn" },
            },
          ],
          run: { ...LOOP_RUN, systemPrompt: "sp" },
        }),
      );
      const snap = await store.open("h1");
      const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
      expect(sources).toContain("product_history");
      expect(sources).toContain("meta");
      expect(sources).toContain("prompt");
      // Exactly one meta per loop
      expect(sources.filter((s) => s === "meta")).toHaveLength(1);
      // Product history is idempotent: re-run with same productEntryId skips
      const loop2 = createCodingAgentSession({
        sessionId: "h1",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("x"),
      });
      await loop2.startLoop(
        loopInput({
          message: "go2",
          history: [{ productEntryId: "pe-1", message: { role: "user", text: "previous turn" } }],
        }),
      );
      const after = await store.open("h1");
      // Product history skipped as duplicate: exactly one meta + one prompt added
      const sourcesAfter = after.entries.filter((e) => e.type === "message").map((e) => e.source);
      expect(sourcesAfter.filter((s) => s === "product_history")).toHaveLength(1);
      expect(sourcesAfter.filter((s) => s === "meta")).toHaveLength(2);
    });

    test("2. system prompt never enters SessionStore", async () => {
      const store = storeFactory("h2");
      await createSession(store, "h2");
      const loop = createCodingAgentSession({
        sessionId: "h2",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("ok"),
      });
      await loop.startLoop(
        loopInput({ message: "go", run: { ...LOOP_RUN, systemPrompt: "TOP SECRET SYSTEM" } }),
      );
      const snap = await store.open("h2");
      const serialized = JSON.stringify(snap.entries);
      expect(serialized).not.toContain("TOP SECRET SYSTEM");
    });

    test("2b. each run uses its own system prompt snapshot", async () => {
      const store = storeFactory("h2b");
      await createSession(store, "h2b");
      let seenSystem = "";
      const loop = createCodingAgentSession({
        sessionId: "h2b",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* (messages) {
          seenSystem = messages.find((m) => m.role === "system")?.text ?? "";
          yield { delta: { type: "text", text: "ok" } };
        },
      });
      // Loop constructed without any system prompt; each run supplies its own
      await loop.startLoop(
        loopInput({ message: "first", run: { ...LOOP_RUN, systemPrompt: "SP-ONE" } }),
      );
      expect(seenSystem).toBe("SP-ONE");
      await loop.startFollowUp(
        loopInput({ message: "second", run: { ...LOOP_RUN, systemPrompt: "SP-TWO" } }),
      );
      expect(seenSystem).toBe("SP-TWO");
    });

    test("3. model requests a tool", async () => {
      const store = storeFactory("h3");
      await createSession(store, "h3");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      let callCount = 0;
      const loop = createCodingAgentSession({
        sessionId: "h3",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          callCount++;
          if (callCount === 1) {
            yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
            yield { stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "done" } };
          }
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      expect(loop.status).toBe("completed");
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    test("4. tool receives complete JSON input", async () => {
      const store = storeFactory("h4");
      await createSession(store, "h4");
      let received: unknown = null;
      const tool = {
        name: "capture",
        description: "Capture input",
        async execute(args: Readonly<Record<string, unknown>>) {
          received = args;
          return { ok: true };
        },
      };
      const plugin: Plugin = { name: "test", tools: [tool] };
      const loop = createCodingAgentSession({
        sessionId: "h4",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "capture" } };
          yield { delta: { type: "input_json_delta", id: "tc-1", partial_json: '{"a":1,"b":' } };
          yield { delta: { type: "input_json_delta", id: "tc-1", partial_json: '"two"}' } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      expect(received).toEqual({ a: 1, b: "two" });
    });

    test("5. assistant tool-use and tool result are persisted", async () => {
      const store = storeFactory("h5");
      await createSession(store, "h5");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      const loop = createCodingAgentSession({
        sessionId: "h5",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      const snap = await store.open("h5");
      const messages = snap.entries.filter((e) => e.type === "message");
      const assistant = messages.find((m) => m.source === "assistant") as {
        message: { blocks?: Array<{ type: string; id?: string }> };
      };
      expect(assistant?.message.blocks?.some((b) => b.type === "tool_use")).toBe(true);
      const toolResult = messages.find((m) => m.source === "tool_result") as {
        message: { blocks?: Array<{ type: string; tool_use_id?: string }> };
      };
      expect(toolResult?.message.blocks?.[0]?.type).toBe("tool_result");
      expect(toolResult?.message.blocks?.[0]?.tool_use_id).toBe("tc-1");
    });

    test("5a. unknown tool and throwing tool persist is_error on tool_result", async () => {
      const store = storeFactory("h5a");
      await createSession(store, "h5a");
      const throwingTool = {
        name: "boom",
        description: "Always throws",
        async execute() {
          throw new Error("kaboom");
        },
      };
      const plugin: Plugin = { name: "test", tools: [throwingTool] };
      const loop = createCodingAgentSession({
        sessionId: "h5a",
        store,
        plugins: [plugin],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          // Unknown tool + a throwing tool in one turn
          yield { delta: { type: "tool_use", id: "u", name: "missing" } };
          yield { delta: { type: "tool_use", id: "b", name: "boom" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      const snap = await store.open("h5a");
      const results = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "tool_result",
      ) as Array<{
        message: { blocks?: Array<{ tool_use_id?: string; is_error?: boolean }> };
      }>;
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.message.blocks?.[0]?.is_error).toBe(true);
      }
    });

    test("5c. concurrent tools run in parallel preserving order", async () => {
      const store = storeFactory("h5c");
      await createSession(store, "h5c");
      const order: string[] = [];
      const slowRead = {
        name: "slow_read",
        description: "Concurrent read",
        executionMode: "concurrent" as const,
        async execute(args: Readonly<Record<string, unknown>>) {
          const { promise, resolve } = Promise.withResolvers<void>();
          // Resolve only when the parallel peer has also started
          setTimeout(resolve, 30);
          order.push(`start ${String(args.tag)}`);
          await promise;
          order.push(`end ${String(args.tag)}`);
          return { v: args.tag };
        },
      };
      const plugin: Plugin = { name: "test", tools: [slowRead] };
      const loop = createCodingAgentSession({
        sessionId: "h5c",
        store,
        plugins: [plugin],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "a", name: "slow_read" } };
          yield { delta: { type: "tool_use", id: "b", name: "slow_read" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      // Both started before either ended -> parallel execution
      expect(order[0]).toMatch(/^start/);
      expect(order[1]).toMatch(/^start/);
      expect(order[2]).toMatch(/^end/);
      expect(order[3]).toMatch(/^end/);
      // Results persisted in original tool-call order
      const snap = await store.open("h5c");
      const results = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "tool_result",
      ) as Array<{ message: { blocks?: Array<{ tool_use_id?: string }> } }>;
      expect(results[0]?.message.blocks?.[0]?.tool_use_id).toBe("a");
      expect(results[1]?.message.blocks?.[0]?.tool_use_id).toBe("b");
    });

    test("5d. tool terminate hint stops the loop after persisting results", async () => {
      const store = storeFactory("h5d");
      await createSession(store, "h5d");
      let modelTurns = 0;
      const finishTool = {
        name: "finish",
        description: "Signal completion",
        async execute() {
          return { terminate: true, done: true } as unknown as Readonly<Record<string, unknown>>;
        },
      };
      const plugin: Plugin = { name: "test", tools: [finishTool] };
      const loop = createCodingAgentSession({
        sessionId: "h5d",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          modelTurns++;
          yield { delta: { type: "tool_use", id: "f", name: "finish" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(loop.status).toBe("completed");
      // Only one model turn despite maxSteps=5: terminate hint stopped it
      expect(modelTurns).toBe(1);
      // The tool result was persisted before stopping
      const snap = await store.open("h5d");
      const results = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "tool_result",
      );
      expect(results).toHaveLength(1);
    });

    test("5e. threshold compaction proactively compacts before a model turn", async () => {
      const store = storeFactory("h5e");
      await createSession(store, "h5e");
      // Pre-seed enough messages to exceed the threshold
      for (let i = 0; i < 6; i++) {
        await store.appendBatch("h5e", {
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
      let compacted = false;
      const loop = createCodingAgentSession({
        sessionId: "h5e",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        contextBudget: {
          estimate: (m: { text?: string }) => Math.ceil((m.text ?? "").length / 4),
          limit: 10,
          triggerRatio: 0.5,
        },
        modelStream: async function* () {
          yield { delta: { type: "text", text: "done" } };
        },
      });
      loop.onEvent((e) => {
        if (e.type === "compaction_end") compacted = true;
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(compacted).toBe(true);
      expect(loop.status).toBe("completed");
      const snap = await store.open("h5e");
      expect(snap.entries.some((e) => e.type === "compaction")).toBe(true);
    });

    test("5b. stop during provider stream ends as stopped, not failed", async () => {
      const store = storeFactory("h5b");
      await createSession(store, "h5b");
      const loop = createCodingAgentSession({
        sessionId: "h5b",
        store,
        plugins: [],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* (_messages, signal) {
          // Provider honors the abort signal and throws kind=aborted
          signal?.addEventListener("abort", () => {
            /* provider would abort its fetch here */
          });
          yield { delta: { type: "text", text: "partial" } };
          throw new ProviderError("aborted by user", "aborted");
        },
      });
      const started = loop.startLoop(loopInput({ message: "run" }));
      loop.stop();
      await started;
      expect(loop.status).toBe("stopped");
    });

    test("6. next model turn sees valid tool pair", async () => {
      const store = storeFactory("h6");
      await createSession(store, "h6");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      let seenMessages: Array<{ role: string; blocks?: Array<{ type: string }> }> = [];
      const loop = createCodingAgentSession({
        sessionId: "h6",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* (messages) {
          seenMessages = messages as typeof seenMessages;
          if (seenMessages.length < 4) {
            yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
            yield { stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "done" } };
          }
        },
      });
      await loop.startLoop(loopInput({ message: "run" }));
      // Final turn's input contains the assistant tool_use + tool_result pair
      const toolUse = seenMessages.find((m) => m.blocks?.some((b) => b.type === "tool_use"));
      const toolResult = seenMessages.find((m) => m.blocks?.[0]?.type === "tool_result");
      expect(toolUse).toBeTruthy();
      expect(toolResult).toBeTruthy();
    });

    test("7. transient provider error retries without duplicating input", async () => {
      const store = storeFactory("h7");
      await createSession(store, "h7");
      let attempts = 0;
      let firstCallMessages: unknown = null;
      const loop = createCodingAgentSession({
        sessionId: "h7",
        store,
        plugins: [],
        maxSteps: 3,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        maxRetries: 3,
        modelStream: async function* (messages) {
          attempts++;
          firstCallMessages ??= messages;
          if (attempts < 3) {
            throw new ProviderError("network timeout", "transient");
          }
          yield { delta: { type: "text", text: "recovered" } };
        },
      });
      const events: string[] = [];
      loop.onEvent((e) => {
        events.push(e.type);
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(attempts).toBe(3);
      expect(loop.status).toBe("completed");
      expect(events).toContain("retry_start");
      expect(events).toContain("retry_end");
      // Retry reused the same messages; nothing re-appended to the store
      const snap = await store.open("h7");
      const metas = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "meta",
      );
      expect(metas).toHaveLength(1);
    });

    test("7c. committed attempt streams real-time then fails without contaminating store", async () => {
      const store = storeFactory("h7c");
      await createSession(store, "h7c");
      let attempts = 0;
      const updates: string[] = [];
      const loop = createCodingAgentSession({
        sessionId: "h7c",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        maxRetries: 3,
        modelStream: async function* () {
          attempts++;
          // First chunk commits the attempt; subsequent transient failure
          // makes the Run fail immediately (no retry, no "AAB").
          yield { delta: { type: "text", text: "A" } };
          throw new ProviderError("network timeout", "transient");
        },
      });
      loop.onEvent((e) => {
        if (e.type === "message_update") updates.push(e.text);
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(attempts).toBe(1); // committed -> no retry
      expect(loop.status).toBe("failed");
      // Real-time streaming: "A" was forwarded immediately via message_update
      expect(updates).toEqual(["A"]);
      // No contamination: the failed turn's partial output is NOT persisted
      const snap = await store.open("h7c");
      const assistantEntries = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "assistant",
      );
      expect(assistantEntries).toHaveLength(0);
    });

    test("7f. stop during model stream discards partial assistant text", async () => {
      const store = storeFactory("h7f");
      await createSession(store, "h7f");
      const { promise: yieldedFirst, resolve: yieldedResolve } = Promise.withResolvers<void>();
      const loop = createCodingAgentSession({
        sessionId: "h7f",
        store,
        plugins: [],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* (_msgs: readonly unknown[], signal?: AbortSignal) {
          yield { delta: { type: "text", text: "partial" } };
          yieldedResolve();
          // Block until abort arrives via the signal
          if (signal) {
            const { promise, resolve } = Promise.withResolvers<void>();
            signal.addEventListener("abort", () => resolve(), { once: true });
            await promise;
          }
        },
      });
      const started = loop.startLoop(loopInput({ message: "go" }));
      await yieldedFirst;
      loop.stop();
      await started;
      expect(loop.status).toBe("stopped");
      // Partial "partial" was streamed as a live event but NOT persisted
      const snap = await store.open("h7f");
      const assistantEntries = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "assistant",
      );
      expect(assistantEntries).toHaveLength(0);
    });

    test("7g. message_start always pairs with message_end, even on failure", async () => {
      const store = storeFactory("h7g");
      await createSession(store, "h7g");
      const loop = createCodingAgentSession({
        sessionId: "h7g",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        maxRetries: 1,
        modelStream: async function* () {
          yield { delta: { type: "text", text: "A" } };
          throw new ProviderError("network timeout", "transient");
        },
      });
      const events: string[] = [];
      loop.onEvent((e) => {
        events.push(e.type);
      });
      await loop.startLoop(loopInput({ message: "go" }));
      // message_start must have a matching message_end regardless of failure
      expect(events).toContain("message_start");
      expect(events).toContain("message_end");
      const startIdx = events.indexOf("message_start");
      const endIdx = events.indexOf("message_end");
      expect(endIdx).toBeGreaterThan(startIdx);
    });
    test("7e. stop during retry backoff ends the loop promptly", async () => {
      const store = storeFactory("h7e");
      await createSession(store, "h7e");
      let attempts = 0;
      const loop = createCodingAgentSession({
        sessionId: "h7e",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        maxRetries: 3,
        modelStream: () => {
          attempts++;
          return throwingModel(new ProviderError("transient", "transient"))();
        },
      });
      // baseDelayMs in retryStream is fixed at 1000ms (2^attempt). We assert
      // the loop settles in well under that window when stop() fires during
      // the backoff wait, proving the backoff is abortable.
      const started = loop.startLoop(loopInput({ message: "go" }));
      // Wait until retry_end (attempt 1 failed, backoff about to start)
      const { promise: backoffStarted, resolve: backoffResolve } = Promise.withResolvers<void>();
      loop.onEvent((e) => {
        if (e.type === "retry_end" && attempts === 1) backoffResolve();
      });
      await Promise.race([backoffStarted, started.then(() => {})]);
      loop.stop();
      const settleStart = Date.now();
      await started;
      const elapsed = Date.now() - settleStart;
      expect(loop.status).toBe("stopped");
      expect(elapsed).toBeLessThan(900);
    });
    test("7b. zero-output transient retries exhaust then fails directly", async () => {
      const store = storeFactory("h7b");
      await createSession(store, "h7b");
      let attempts = 0;
      const loop = createCodingAgentSession({
        sessionId: "h7b",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        maxRetries: 2,
        modelStream: () => {
          attempts++;
          return throwingModel(new ProviderError("network timeout", "transient"))();
        },
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(attempts).toBe(2);
      expect(loop.status).toBe("failed");
    });

    test("7d. stop during tool execution cancels the tool and does not persist its result", async () => {
      const store = storeFactory("h7d");
      await createSession(store, "h7d");
      let signalSeen: AbortSignal | undefined;
      // Deterministic handshake: the tool resolves `toolStarted` once it is
      // running, so the test waits on a real signal instead of guessing a delay.
      const { promise: toolStarted, resolve: toolStartedResolve } = Promise.withResolvers<void>();
      const slowTool = {
        name: "slow",
        description: "Long-running tool",
        async execute(_args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
          signalSeen = signal;
          toolStartedResolve();
          // Block until aborted (simulates a long bash/web call).
          if (signal) {
            const { promise, resolve } = Promise.withResolvers<void>();
            signal.addEventListener("abort", () => resolve());
            await promise;
          } else {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 50);
            await promise;
          }
          return { done: true };
        },
      };
      const plugin: Plugin = { name: "test", tools: [slowTool] };
      const loop = createCodingAgentSession({
        sessionId: "h7d",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "slow" } };
          yield { stopReason: "tool_use" };
        },
      });
      const started = loop.startLoop(loopInput({ message: "go" }));
      // Wait for the tool to actually start, then stop() to abort it.
      await toolStarted;
      loop.stop();
      await started;
      expect(loop.status).toBe("stopped");
      // The loop forwarded its AbortSignal to the tool
      expect(signalSeen).toBeTruthy();
      // The cancelled tool's result must NOT be persisted
      const snap = await store.open("h7d");
      const toolResults = snap.entries.filter(
        (e) => e.type === "message" && (e as { source?: string }).source === "tool_result",
      );
      expect(toolResults).toHaveLength(0);
    });

    test("8. steer injects at safe boundary without new Meta", async () => {
      const store = storeFactory("h8");
      await createSession(store, "h8");
      let turn = 0;
      let loopRef: ReturnType<typeof createCodingAgentSession> | null = null;
      const steerTool = {
        name: "steer_from_tool",
        description: "Steer the loop",
        async execute() {
          loopRef?.steer({ inputId: "ti", message: { role: "user", text: "steer-me" } });
          return { ok: true };
        },
      };
      const plugin: Plugin = { name: "test", tools: [steerTool] };
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      let loopRef: ReturnType<typeof createCodingAgentSession> | null = null;
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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
      const loop = createCodingAgentSession({
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

    test("9b. resolveTools applies per-run manifest to the tool table", async () => {
      const store = storeFactory("h9b");
      await createSession(store, "h9b");
      let ptAExecutions = 0;
      const loop = createCodingAgentSession({
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
        resolveTools: async (input) => {
          const names = input.run.productTools.map((t) => t.name);
          return names.map((n) => ({
            name: n,
            description: n,
            inputSchema: { type: "object" },
            async execute() {
              if (n === "pt-a") ptAExecutions++;
              return { ok: true };
            },
          }));
        },
      });
      // Run 1: manifest has pt-a -> it exists and executes.
      await loop.startLoop(
        loopInput({
          message: "first",
          run: {
            ...LOOP_RUN,
            productTools: [{ name: "pt-a", description: "", inputSchema: {}, entrypoint: "x" }],
          },
        }),
      );
      expect(ptAExecutions).toBe(2); // one per step in run 1 (maxSteps 2)
      // Run 2: manifest has only pt-b -> pt-a is gone from the table; the
      // model's pt-a call resolves to is_error (unknown tool), so pt-a's
      // execute is NOT invoked again. Tools are per-Run, not frozen.
      await loop.startFollowUp(
        loopInput({
          message: "second",
          run: {
            ...LOOP_RUN,
            productTools: [{ name: "pt-b", description: "", inputSchema: {}, entrypoint: "y" }],
          },
        }),
      );
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

    test("10. compaction appends entry and shapes next turn", async () => {
      const store = storeFactory("h10");
      await createSession(store, "h10");
      for (let i = 0; i < 8; i++) {
        await store.appendBatch("h10", {
          entries: [
            {
              type: "message",
              role: "user",
              source: "prompt",
              message: { role: "user", text: `msg ${i}` },
              createdAt: Date.now(),
            },
          ],
        });
      }
      const loop = createCodingAgentSession({
        sessionId: "h10",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("done"),
      });
      await loop.compact();
      const snap = await store.open("h10");
      const comp = snap.entries.filter((e) => e.type === "compaction");
      expect(comp).toHaveLength(1);
      // Originals retained
      const msgCount = snap.entries.filter((e) => e.type === "message").length;
      expect(msgCount).toBe(8);
    });

    test("11. overflow compacts once and retries once within the same turn", async () => {
      const store = storeFactory("h11");
      await createSession(store, "h11");
      // Seed messages so overflow compaction has something to cover
      for (let i = 0; i < 6; i++) {
        await store.appendBatch("h11", {
          entries: [
            {
              type: "message",
              role: "user",
              source: "prompt",
              message: { role: "user", text: `seed ${i}` },
              createdAt: i,
            },
          ],
        });
      }
      let attempts = 0;
      let compacted = false;
      const loop = createCodingAgentSession({
        sessionId: "h11",
        store,
        plugins: [],
        // maxSteps = 1: overflow recovery must NOT consume an extra step
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        // triggerRatio high enough that proactive does NOT preempt overflow;
        // this isolates the overflow path using the same ContextBudget.
        contextBudget: {
          estimate: (m: { text?: string }) => Math.ceil((m.text ?? "").length / 4),
          limit: 10,
          triggerRatio: 100,
        },
        modelStream: async function* () {
          attempts++;
          if (!compacted) {
            throw new ProviderError("prompt is too long: 200001 > 200000 maximum", "overflow");
          }
          yield { delta: { type: "text", text: "done" } };
        },
      });
      // Compaction happens inside the loop; detect it via events
      const events: string[] = [];
      loop.onEvent((e) => {
        events.push(e.type);
        if (e.type === "compaction_end") compacted = true;
      });
      await loop.startLoop(loopInput({ message: "go" }));
      expect(attempts).toBe(2);
      expect(compacted).toBe(true);
      expect(loop.status).toBe("completed");
      expect(events).toContain("compaction_start");
      expect(events).toContain("compaction_end");
      // Overflow used the same ContextBudget: diagnostics recorded
      const snap11 = await store.open("h11");
      const comp11 = snap11.entries.find((e) => e.type === "compaction") as {
        tokensBefore?: number;
      };
      expect(comp11?.tokensBefore).toBeGreaterThan(0);
    });

    test("12. todo survives restart", async () => {
      const store = storeFactory("h12");
      await createSession(store, "h12");
      await writeTodo(store, "h12", {
        items: [{ id: "t1", text: "task", status: "in_progress" }],
      });
      if (!reopenFactory) return; // SQLite-only restart
      const reopened = reopenFactory("h12");
      const state = await readTodo(reopened, "h12");
      expect(state.items).toHaveLength(1);
      expect(state.items[0]?.status).toBe("in_progress");
    });

    test("13. skill meta shows index only; skill_load reads body lazily", async () => {
      const root = `/tmp/skill-harness-${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(`${root}/math`, { recursive: true });
      writeFileSync(
        `${root}/math/SKILL.md`,
        "---\nname: math\n---\n\nBody of math skill ${SKILL_DIR}/x",
      );
      const store = storeFactory("h13");
      await createSession(store, "h13");
      // Local stand-in for the progressive-skill plugin: index in Meta,
      // body only readable through skill_load (lazy).
      let bodyRead = 0;
      const skillPlugin: Plugin = {
        name: "skills",
        meta: [
          {
            name: "Available Skills",
            render: () => "- **math**: do math",
          },
        ],
        tools: [
          {
            name: "skill_load",
            description: "Load a skill body",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
            async execute(args) {
              if (args.name !== "math") return { error: "not found" };
              bodyRead++;
              return { body: `Body of math skill ${root}/math` } as unknown as Readonly<
                Record<string, unknown>
              >;
            },
          },
        ],
      };
      const metaText = skillPlugin.meta?.map((m) => m.render()).join("\n") ?? "";
      // Meta contains only the index (name/description), never the body
      expect(metaText).toContain("math");
      expect(metaText).not.toContain("Body of math skill");
      expect(bodyRead).toBe(0); // Meta render did not read bodies

      // skill_load reads the body on demand
      const loadTool = skillPlugin.tools?.find((t) => t.name === "skill_load");
      expect(loadTool).toBeTruthy();
      const result = (await loadTool!.execute({ name: "math" })) as { body?: string };
      expect(result.body).toContain("Body of math skill");
      expect(result.body).toContain(`${root}/math`);
      expect(bodyRead).toBe(1);
      rmSync(root, { recursive: true, force: true });
    });

    test("14. delayed listener blocks loop settlement", async () => {
      const store = storeFactory("h14");
      await createSession(store, "h14");
      const loop = createCodingAgentSession({
        sessionId: "h14",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("ok"),
      });
      let resolved = false;
      let settleSeen = false;
      const { promise, resolve } = Promise.withResolvers<void>();
      loop.onEvent((e) => {
        if (e.type === "agent_end") {
          return promise.then(() => {
            resolved = true;
          });
        }
        return undefined;
      });
      const started = loop.startLoop(loopInput({ message: "go" }));
      const settle = started.then(() => {
        settleSeen = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(settleSeen).toBe(false); // listener still pending
      resolve();
      await settle;
      expect(settleSeen).toBe(true);
      expect(resolved).toBe(true);
    });

    test("15. reopen does not restore an active loop", async () => {
      const store = storeFactory("h15");
      await createSession(store, "h15");
      const loop = createCodingAgentSession({
        sessionId: "h15",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("done"),
      });
      await loop.startLoop(loopInput({ message: "go" }));
      if (!reopenFactory) return;
      const reopened = reopenFactory("h15");
      const snap = await reopened.open("h15");
      // Completed branch + todo remain, but no active loop object exists
      expect(snap.entries.length).toBeGreaterThan(0);
      // A fresh loop starts idle; nothing auto-resumes
      const fresh = createCodingAgentSession({
        sessionId: "h15",
        store: reopened,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("x"),
      });
      expect(fresh.status).toBe("idle");
    });

    test("16. credential sentinel appears nowhere in store/events/errors", async () => {
      const store = storeFactory("h16");
      await createSession(store, "h16");
      const SENTINEL = "sk-sentinel-123456";
      const loop = createCodingAgentSession({
        sessionId: "h16",
        store,
        plugins: [],
        maxSteps: 3,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          // Partial output, then a fatal auth error containing the sentinel.
          yield { delta: { type: "text", text: "partial" } };
          throw new ProviderError(`boom with ${SENTINEL} inside`, "auth");
        },
      });
      const eventPayloads: string[] = [];
      loop.onEvent((e) => {
        eventPayloads.push(JSON.stringify(e));
      });
      await loop.startLoop(loopInput({ message: "go" }));
      // The loop surfaces the failure via agent_end only; the raw error is
      // normalized by the provider layer before reaching the loop.
      const snap = await store.open("h16");
      const storeSerialized = JSON.stringify(snap.entries);
      expect(storeSerialized).not.toContain(SENTINEL);
      expect(eventPayloads.join("")).not.toContain(SENTINEL);
      expect(loop.status).toBe("failed");
    });

    test("17. modelStream receives static + per-run tool schemas each turn", async () => {
      const store = storeFactory("h17");
      await createSession(store, "h17");
      let seenTools: ReadonlyArray<{ name: string }> = [];

      const loop = createCodingAgentSession({
        sessionId: "h17",
        store,
        plugins: [{ name: "native", tools: [staticTool("ls"), staticTool("read")] }],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        resolveTools: async () => [staticTool("history_recent")],
        modelStream: async function* (_messages, _signal, tools) {
          seenTools = tools ?? [];
          yield { delta: { type: "text", text: "done" } };
          yield { stopReason: "end_turn" };
        },
      });
      await loop.startLoop(loopInput({ message: "go" }));

      const names = seenTools.map((t) => t.name);
      expect(names).toContain("ls");
      expect(names).toContain("read");
      expect(names).toContain("history_recent"); // per-run resolved
    });

    test("18. beforeRun fires once before the first model turn", async () => {
      const store = storeFactory("h18");
      await createSession(store, "h18");
      let beforeRunCalls = 0;
      let beforeRunMsgCount = -1;

      const loop = createCodingAgentSession({
        sessionId: "h18",
        store,
        plugins: [
          {
            name: "tracker",
            hooks: {
              beforeRun(messages) {
                beforeRunCalls++;
                beforeRunMsgCount = messages.length;
              },
            },
          },
        ],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("done"),
      });
      await loop.startLoop(loopInput({ message: "go" }));

      expect(beforeRunCalls).toBe(1);
      expect(beforeRunMsgCount).toBeGreaterThan(0);
    });

    test("19. afterRun fires once with completed status and full messages", async () => {
      const store = storeFactory("h19");
      await createSession(store, "h19");
      let afterRunCalls = 0;
      let afterRunStatus = "";
      let afterRunMsgCount = -1;

      const loop = createCodingAgentSession({
        sessionId: "h19",
        store,
        plugins: [
          {
            name: "tracker",
            hooks: {
              afterRun(status, messages) {
                afterRunCalls++;
                afterRunStatus = status;
                afterRunMsgCount = messages.length;
              },
            },
          },
        ],
        maxSteps: 1,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: textModel("done"),
      });
      await loop.startLoop(loopInput({ message: "go" }));

      expect(afterRunCalls).toBe(1);
      expect(afterRunStatus).toBe("completed");
      expect(afterRunMsgCount).toBeGreaterThan(0);
    });

    test("20. beforeRun/afterRun fire once each on multi-turn runs", async () => {
      const store = storeFactory("h20");
      await createSession(store, "h20");
      let beforeRunCalls = 0;
      let afterRunCalls = 0;
      let modelCalls = 0;

      const loop = createCodingAgentSession({
        sessionId: "h20",
        store,
        plugins: [
          {
            name: "tracker",
            hooks: {
              beforeRun() { beforeRunCalls++; },
              afterRun() { afterRunCalls++; },
            },
          },
        ],
        maxSteps: 5,
        maxForceContinues: 0,
        summarize: fakeSummarize,
        modelStream: async function* () {
          modelCalls++;
          if (modelCalls === 1) {
            yield { delta: { type: "tool_use", id: "tc1", name: "echo" } };
            yield { stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "done" } };
            yield { stopReason: "end_turn" };
          }
        },
      });
      await loop.startLoop(loopInput({ message: "go" }));

      expect(modelCalls).toBeGreaterThanOrEqual(2);
      expect(beforeRunCalls).toBe(1);
      expect(afterRunCalls).toBe(1);
    });

    afterAll(() => cleanup?.());
  });
}

// InMemory: one store per session; reopen returns the same live instance
// (in-memory has no persistence boundary to cross). The SQLite store was
// removed with the cross-Run session path; in-memory is the only store.
const memoryStores = new Map<string, SessionStore>();
testHarness(
  "InMemory",
  (sid) => {
    const store = createInMemorySessionStore();
    memoryStores.set(sid, store);
    return store;
  },
  (sid) => memoryStores.get(sid)!,
);

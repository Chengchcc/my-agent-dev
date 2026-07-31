import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import type { SessionStore } from "../persistence/session-store.js";
import { createSqliteSessionStore } from "../persistence/sqlite-session-store.js";
import { createAgentLoop } from "./agent-loop.js";
import type { Plugin } from "./plugin.js";
import { readTodo, writeTodo } from "./todo.js";

type StoreFactory = (sid: string) => SessionStore;
type ReopenFactory = (sid: string) => SessionStore;

function createSession(store: SessionStore, sid: string) {
  return store.create({
    sessionId: sid,
    backendKind: "coding_agent",
    workspaceRoot: "/ws",
    modelRef: { backendKind: "test", modelId: "m1" },
    systemPromptHash: null,
    activeLoopId: null,
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

function echoTool(name = "echo") {
  return {
    name,
    description: "Echo input",
    async execute(args: Readonly<Record<string, unknown>>) {
      return { echoed: args } as unknown as Readonly<Record<string, unknown>>;
    },
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
      const loop = createAgentLoop({
        sessionId: "h1",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });
      await loop.startLoop({
        systemPrompt: "sp",
        metaText: "meta",
        promptText: "go",
        history: [
          {
            productEntryId: "pe-1",
            message: { role: "user", text: "previous turn" },
          },
        ],
      });
      const snap = await store.open("h1");
      const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
      expect(sources).toContain("product_history");
      expect(sources).toContain("meta");
      expect(sources).toContain("prompt");
      // Exactly one meta per loop
      expect(sources.filter((s) => s === "meta")).toHaveLength(1);
      // Product history is idempotent: re-run with same productEntryId skips
      const loop2 = createAgentLoop({
        sessionId: "h1",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        modelStream: textModel("x"),
      });
      await loop2.startLoop({
        systemPrompt: "",
        metaText: "m2",
        promptText: "go2",
        history: [{ productEntryId: "pe-1", message: { role: "user", text: "previous turn" } }],
      });
      const after = await store.open("h1");
      // Product history skipped as duplicate: exactly one meta + one prompt added
      const sourcesAfter = after.entries.filter((e) => e.type === "message").map((e) => e.source);
      expect(sourcesAfter.filter((s) => s === "product_history")).toHaveLength(1);
      expect(sourcesAfter.filter((s) => s === "meta")).toHaveLength(2);
    });

    test("2. system prompt never enters SessionStore", async () => {
      const store = storeFactory("h2");
      await createSession(store, "h2");
      const loop = createAgentLoop({
        sessionId: "h2",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        modelStream: textModel("ok"),
      });
      await loop.startLoop({ systemPrompt: "TOP SECRET SYSTEM", metaText: "", promptText: "go" });
      const snap = await store.open("h2");
      const serialized = JSON.stringify(snap.entries);
      expect(serialized).not.toContain("TOP SECRET SYSTEM");
    });

    test("2b. each run uses its own system prompt snapshot", async () => {
      const store = storeFactory("h2b");
      await createSession(store, "h2b");
      let seenSystem = "";
      const loop = createAgentLoop({
        sessionId: "h2b",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: async function* (messages) {
          seenSystem = messages.find((m) => m.role === "system")?.text ?? "";
          yield { delta: { type: "text", text: "ok" } };
        },
      });
      // Loop constructed without any system prompt; each run supplies its own
      await loop.startLoop({ systemPrompt: "SP-ONE", metaText: "", promptText: "first" });
      expect(seenSystem).toBe("SP-ONE");
      await loop.startFollowUp({ systemPrompt: "SP-TWO", metaText: "", promptText: "second" });
      expect(seenSystem).toBe("SP-TWO");
    });

    test("3. model requests a tool", async () => {
      const store = storeFactory("h3");
      await createSession(store, "h3");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      let callCount = 0;
      const loop = createAgentLoop({
        sessionId: "h3",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
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
      const loop = createAgentLoop({
        sessionId: "h4",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "capture" } };
          yield { delta: { type: "input_json_delta", id: "tc-1", partial_json: '{"a":1,"b":' } };
          yield { delta: { type: "input_json_delta", id: "tc-1", partial_json: '"two"}' } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
      expect(received).toEqual({ a: 1, b: "two" });
    });

    test("5. assistant tool-use and tool result are persisted", async () => {
      const store = storeFactory("h5");
      await createSession(store, "h5");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      const loop = createAgentLoop({
        sessionId: "h5",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
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
      const loop = createAgentLoop({
        sessionId: "h5a",
        store,
        plugins: [plugin],
        maxSteps: 1,
        maxForceContinues: 0,
        modelStream: async function* () {
          // Unknown tool + a throwing tool in one turn
          yield { delta: { type: "tool_use", id: "u", name: "missing" } };
          yield { delta: { type: "tool_use", id: "b", name: "boom" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
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
      const loop = createAgentLoop({
        sessionId: "h5c",
        store,
        plugins: [plugin],
        maxSteps: 1,
        maxForceContinues: 0,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "a", name: "slow_read" } };
          yield { delta: { type: "tool_use", id: "b", name: "slow_read" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
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
      const loop = createAgentLoop({
        sessionId: "h5d",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* () {
          modelTurns++;
          yield { delta: { type: "tool_use", id: "f", name: "finish" } };
          yield { stopReason: "tool_use" };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
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
      const loop = createAgentLoop({
        sessionId: "h5e",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        compactionThreshold: 4,
        modelStream: async function* () {
          yield { delta: { type: "text", text: "done" } };
        },
      });
      loop.onEvent((e) => {
        if (e.type === "compaction_end") compacted = true;
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(compacted).toBe(true);
      expect(loop.status).toBe("completed");
      const snap = await store.open("h5e");
      expect(snap.entries.some((e) => e.type === "compaction")).toBe(true);
    });

    test("5b. stop during provider stream ends as stopped, not failed", async () => {
      const store = storeFactory("h5b");
      await createSession(store, "h5b");
      const loop = createAgentLoop({
        sessionId: "h5b",
        store,
        plugins: [],
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* (_messages, signal) {
          // Provider honors the abort signal and throws kind=aborted
          signal?.addEventListener("abort", () => {
            /* provider would abort its fetch here */
          });
          yield { delta: { type: "text", text: "partial" } };
          throw new ProviderError("aborted by user", "aborted");
        },
      });
      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
      loop.stop();
      await started;
      expect(loop.status).toBe("stopped");
    });

    test("6. next model turn sees valid tool pair", async () => {
      const store = storeFactory("h6");
      await createSession(store, "h6");
      const plugin: Plugin = { name: "test", tools: [echoTool()] };
      let seenMessages: Array<{ role: string; blocks?: Array<{ type: string }> }> = [];
      const loop = createAgentLoop({
        sessionId: "h6",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
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
      const loop = createAgentLoop({
        sessionId: "h7",
        store,
        plugins: [],
        maxSteps: 3,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
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

    test("7c. failed retry attempt partial output does not contaminate final message", async () => {
      const store = storeFactory("h7c");
      await createSession(store, "h7c");
      let attempts = 0;
      const loop = createAgentLoop({
        sessionId: "h7c",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
        maxRetries: 3,
        modelStream: async function* () {
          attempts++;
          // First attempt emits partial text "A" then fails transiently;
          // second attempt emits the complete text "AB".
          if (attempts === 1) {
            yield { delta: { type: "text", text: "A" } };
            throw new ProviderError("network timeout", "transient");
          }
          yield { delta: { type: "text", text: "AB" } };
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(attempts).toBe(2);
      expect(loop.status).toBe("completed");
      // The canonical transcript must contain only the successful attempt's
      // output ("AB"), never the failed "A" prefix ("AAB").
      const snap = await store.open("h7c");
      const assistantText = snap.entries
        .filter((e) => e.type === "message" && (e as { source?: string }).source === "assistant")
        .map((e) => (e as { message: { text?: string } }).message.text ?? "")
        .join("");
      expect(assistantText).toBe("AB");
    });

    test("7e. stop during retry backoff ends the loop promptly", async () => {
      const store = storeFactory("h7e");
      await createSession(store, "h7e");
      let attempts = 0;
      const loop = createAgentLoop({
        sessionId: "h7e",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        maxRetries: 3,
        modelStream: async function* () {
          attempts++;
          yield { delta: { type: "text", text: "x" } };
          throw new ProviderError("transient", "transient");
        },
      });
      // baseDelayMs in retryStream is fixed at 1000ms (2^attempt). We assert
      // the loop settles in well under that window when stop() fires during
      // the backoff wait, proving the backoff is abortable.
      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      // Deterministic handshake: wait until the first attempt has failed and
      // the backoff has begun (attempts === 1, retryStart emitted).
      const { promise: firstFailed, resolve: firstFailedResolve } = Promise.withResolvers<void>();
      loop.onEvent((e) => {
        if (e.type === "retry_start" && attempts === 1) firstFailedResolve();
      });
      await Promise.race([firstFailed, started.then(() => {})]);
      loop.stop();
      const settleStart = Date.now();
      await started;
      const elapsed = Date.now() - settleStart;
      expect(loop.status).toBe("stopped");
      // Must settle far faster than the 1000ms backoff.
      expect(elapsed).toBeLessThan(900);
    });

    test("7b. retries exhausted fails directly, no extra outer retry", async () => {
      const store = storeFactory("h7b");
      await createSession(store, "h7b");
      let attempts = 0;
      const loop = createAgentLoop({
        sessionId: "h7b",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        maxRetries: 2,
        modelStream: async function* () {
          attempts++;
          yield { delta: { type: "text", text: "partial" } };
          throw new ProviderError("network timeout", "transient");
        },
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      // retryStream does exactly maxRetries provider calls, then the loop
      // fails without consuming the second maxStep.
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
      const loop = createAgentLoop({
        sessionId: "h7d",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* () {
          yield { delta: { type: "tool_use", id: "tc-1", name: "slow" } };
          yield { stopReason: "tool_use" };
        },
      });
      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
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
      let loopRef: ReturnType<typeof createAgentLoop> | null = null;
      const steerTool = {
        name: "steer_from_tool",
        description: "Steer the loop",
        async execute() {
          loopRef?.steer("steer-me");
          return { ok: true };
        },
      };
      const plugin: Plugin = { name: "test", tools: [steerTool] };
      const loop = createAgentLoop({
        sessionId: "h8",
        store,
        plugins: [plugin],
        maxSteps: 5,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      const snap = await store.open("h8");
      const sources = snap.entries.filter((e) => e.type === "message").map((e) => e.source);
      expect(sources).toContain("steer");
      // One Meta for the whole loop; steer never adds one
      expect(sources.filter((s) => s === "meta")).toHaveLength(1);
    });

    test("9. follow-up creates a new loop with new Meta", async () => {
      const store = storeFactory("h9");
      await createSession(store, "h9");
      const loop = createAgentLoop({
        sessionId: "h9",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });
      await loop.startLoop({ systemPrompt: "", metaText: "meta-1", promptText: "first" });
      await loop.startFollowUp({ systemPrompt: "", metaText: "meta-2", promptText: "second" });
      const snap = await store.open("h9");
      const metas = snap.entries
        .filter((e) => e.type === "message" && e.source === "meta")
        .map((e) => (e as { message: { text: string } }).message.text);
      expect(metas).toEqual(["meta-1", "meta-2"]);
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
      const loop = createAgentLoop({
        sessionId: "h10",
        store,
        plugins: [],
        maxSteps: 1,
        maxForceContinues: 0,
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
      let attempts = 0;
      let compacted = false;
      const loop = createAgentLoop({
        sessionId: "h11",
        store,
        plugins: [],
        // maxSteps = 1: overflow recovery must NOT consume an extra step
        maxSteps: 1,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(attempts).toBe(2);
      expect(compacted).toBe(true);
      expect(loop.status).toBe("completed");
      expect(events).toContain("compaction_start");
      expect(events).toContain("compaction_end");
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
      const loop = createAgentLoop({
        sessionId: "h14",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
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
      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
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
      const loop = createAgentLoop({
        sessionId: "h15",
        store,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      if (!reopenFactory) return;
      const reopened = reopenFactory("h15");
      const snap = await reopened.open("h15");
      // Completed branch + todo remain, but no active loop object exists
      expect(snap.entries.length).toBeGreaterThan(0);
      // A fresh loop starts idle; nothing auto-resumes
      const fresh = createAgentLoop({
        sessionId: "h15",
        store: reopened,
        plugins: [],
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("x"),
      });
      expect(fresh.status).toBe("idle");
    });

    test("16. credential sentinel appears nowhere in store/events/errors", async () => {
      const store = storeFactory("h16");
      await createSession(store, "h16");
      const SENTINEL = "sk-sentinel-123456";
      const loop = createAgentLoop({
        sessionId: "h16",
        store,
        plugins: [],
        maxSteps: 3,
        maxForceContinues: 0,
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
      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      // The loop surfaces the failure via agent_end only; the raw error is
      // normalized by the provider layer before reaching the loop.
      const snap = await store.open("h16");
      const storeSerialized = JSON.stringify(snap.entries);
      expect(storeSerialized).not.toContain(SENTINEL);
      expect(eventPayloads.join("")).not.toContain(SENTINEL);
      expect(loop.status).toBe("failed");
    });

    afterAll(() => cleanup?.());
  });
}

// InMemory: one store per session; reopen returns the same live instance
// (in-memory has no persistence boundary to cross).
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

// SQLite: one file per session so reopen works against the same file
const sqliteDirs = new Map<string, string>();
testHarness(
  "SQLite",
  (sid) => {
    const dir = `/tmp/harness-sqlite-${sid}-${Math.random().toString(36).slice(2, 8)}`;
    sqliteDirs.set(sid, dir);
    mkdirSync(dir, { recursive: true });
    return createSqliteSessionStore(`${dir}/${sid}.db`);
  },
  (sid) => {
    const dir = sqliteDirs.get(sid)!;
    return createSqliteSessionStore(`${dir}/${sid}.db`);
  },
  () => {
    for (const dir of sqliteDirs.values()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  },
);

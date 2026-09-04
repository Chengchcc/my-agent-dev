import { describe, expect, test } from "bun:test";
import { ProviderError } from "@chengchenccc/ai";
import { createOmaSession } from "./agent-loop.js";
import {
  createMemoryStores,
  createSession,
  echoTool,
  fakeSummarize,
  loopInput,
  throwingModel,
} from "./coding-agent-harness.fixture.js";
import type { Plugin } from "./plugin.js";

const { storeFactory } = createMemoryStores();

describe("agent loop harness tools/retry/stop", () => {
  test("5f. stop during provider stream ends as stopped, not failed", async () => {
    const store = storeFactory("h5b");
    await createSession(store, "h5b");
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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

  test("7h. stop during tool turn leaves no dangling tool_use in tree", async () => {
    const store = storeFactory("h7h");
    await createSession(store, "h7h");
    const { promise: toolStarted, resolve: signalToolStarted } = Promise.withResolvers<void>();
    const { promise: allowFinish, resolve: allowFinishResolve } = Promise.withResolvers<void>();
    const plugin: Plugin = {
      name: "test",
      tools: [
        {
          name: "block",
          description: "blocking tool",
          inputSchema: { type: "object" },
          async execute() {
            signalToolStarted();
            await allowFinish;
            return { ok: true };
          },
        },
      ],
    };
    const loop = createOmaSession({
      sessionId: "h7h",
      store,
      plugins: [plugin],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        yield { delta: { type: "tool_use", id: "tc-dangling", name: "block" } };
        yield { stopReason: "tool_use" };
      },
    });
    const started = loop.startLoop(loopInput({ message: "go" }));
    // Wait for the tool to start executing (loop is blocked in executeTools).
    await toolStarted;
    // Stop while tools are running.
    loop.stop();
    // Let the tool finish so executeTools returns and the abort check fires.
    allowFinishResolve();
    await started;
    expect(loop.status).toBe("stopped");

    // Dangling invariant: tool_use without tool_result corrupts the
    // branch on resume (API 400). The tree must not have one.
    const snap = await store.open("h7h");
    const msgEntries = snap.entries.filter((e) => e.type === "message");
    const hasToolUse = msgEntries.some((e) => {
      const blocks = (e as { message?: { blocks?: Array<{ type: string }> } }).message?.blocks;
      return blocks?.some((b) => b.type === "tool_use");
    });
    const hasToolResult = msgEntries.some((e) => {
      const blocks = (e as { message?: { blocks?: Array<{ type: string }> } }).message?.blocks;
      return blocks?.some((b) => b.type === "tool_result");
    });
    if (hasToolUse) expect(hasToolResult).toBe(true);
  });

  test("7g. message_start always pairs with message_end, even on failure", async () => {
    const store = storeFactory("h7g");
    await createSession(store, "h7g");
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
});

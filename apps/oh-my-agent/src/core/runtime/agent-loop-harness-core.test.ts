import { describe, expect, test } from "bun:test";
import { createOmaSession } from "./agent-loop.js";
import {
  createMemoryStores,
  createSession,
  echoTool,
  fakeSummarize,
  LOOP_RUN,
  loopInput,
  textModel,
} from "./coding-agent-harness.fixture.js";
import type { Plugin } from "./plugin.js";

const { storeFactory } = createMemoryStores();

describe("agent loop harness core", () => {
  test("1. product history + one Meta + one Prompt enter the tree", async () => {
    const store = storeFactory("h1");
    await createSession(store, "h1");
    const loop = createOmaSession({
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
    const loop2 = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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

  test("5b. interleaved thinking/text collapses thinking to one block with one signature", async () => {
    const store = storeFactory("h5b");
    await createSession(store, "h5b");
    const loop = createOmaSession({
      sessionId: "h5b",
      store,
      plugins: [{ name: "test", tools: [echoTool()] }],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        // thinking -> text -> thinking (interleaved), then a tool_use.
        yield { delta: { type: "reasoning", text: "think one" } };
        yield { delta: { type: "text", text: "say this" } };
        yield { delta: { type: "reasoning", text: "think two" } };
        yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
        yield { stopReason: "tool_use" };
      },
    });
    await loop.startLoop(loopInput({ message: "run" }));
    const snap = await store.open("h5b");
    const assistant = snap.entries.find((e) => e.source === "assistant") as unknown as {
      message: {
        blocks?: Array<{ type: string; text?: string; signature?: string }>;
      };
    };
    const blocks = assistant?.message.blocks ?? [];
    const thinking = blocks.filter((b) => b.type === "thinking");
    const texts = blocks.filter((b) => b.type === "text");
    // Anthropic requires one <thinking> per assistant message: all thinking
    // strands collapse into a single block carrying the one signature.
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.text).toContain("think one");
    expect(texts.map((t) => t.text)).toEqual(["say this"]);
    // The collapsed thinking block sits at the position of the FIRST
    // thinking fragment (before the text), so the trace keeps the order.
    expect(blocks[0]?.type).toBe("thinking");
  });

  test("5c. consecutive streaming deltas merge into one block per segment", async () => {
    const store = storeFactory("h5c");
    await createSession(store, "h5c");
    const loop = createOmaSession({
      sessionId: "h5c",
      store,
      plugins: [],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        yield { delta: { type: "reasoning", text: "think " } };
        yield { delta: { type: "text", text: "让" } };
        yield { delta: { type: "text", text: "\n\n" } };
        yield { delta: { type: "text", text: "我" } };
        yield { delta: { type: "reasoning", text: "think2 " } };
        yield { delta: { type: "reasoning", text: "more" } };
        yield { delta: { type: "text", text: "再" } };
        yield { stopReason: "end_turn" };
      },
    });
    await loop.startLoop(loopInput({ message: "run" }));
    const snap = await store.open("h5c");
    const assistant = snap.entries.find((e) => e.source === "assistant") as unknown as {
      message: { blocks?: Array<{ type: string; text?: string }> };
    };
    expect(assistant?.message.blocks).toEqual([
      { type: "thinking", text: "think " },
      { type: "text", text: "让\n\n我" },
      { type: "thinking", text: "think2 more" },
      { type: "text", text: "再" },
    ]);
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
    const loop = createOmaSession({
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
});

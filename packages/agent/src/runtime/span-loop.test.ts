import { describe, expect, test } from "bun:test";
import type {
  AIMessageChunk,
  ChatModel,
  ContentBlock,
  Tool,
  ToolResultBlock,
} from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { AgentRuntime, FollowUpQueue, SteeringQueue } from "./agent-options.js";
import {
  consoleLogger,
  createContextStore,
  createThread,
  inMemoryCheckpointer,
  memorySessionStorage,
  passthroughContextManager,
  Session,
} from "./create-agent.js";
import { createPluginRunner } from "./plugin-dispatcher.js";
import { spanLoop } from "./span-loop.js";

/** Consume an async iterable to completion (side-effect-only tests). */
async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) {
    /* consume */
  }
}

/** Type predicate: narrow ContentBlock → ToolResultBlock. */
function isToolResult(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}

function makeRt(opts: { tools?: Tool[]; messages?: Message[] } = {}): AgentRuntime {
  const tools = opts.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const checkpointer = inMemoryCheckpointer();
  const logger = consoleLogger({ level: "silent" });
  return {
    thread: createThread(opts.messages ?? [], "t1"),
    session: new Session(memorySessionStorage()),
    plugins: createPluginRunner(
      [],
      {
        sessionId: "t1",
        signal: undefined,
        logger,
        messageStore: checkpointer,
        eventLog: checkpointer as never,
        interruptStore: checkpointer as never,
        contextManager: passthroughContextManager(),
        context: createContextStore(),
        emit: () => {},
      },
      logger,
    ),
    toolMap,
    messageStore: checkpointer,
    eventLog: checkpointer as never,
    interruptStore: checkpointer as never,
    contextManager: passthroughContextManager(),
    logger,
    model: { id: "test", stream: async function* () {}, countTokens: async () => 0 },
    tools,
    pendingEvents: [],
    save: async () => {},
    spanId: "run-1",
    toolStates: [],
    assistantBlocks: [],
    subscribers: new Set(),
    context: createContextStore(),
  } as unknown as AgentRuntime;
}

function toolUseModel(calls: Array<{ id: string; name: string; input?: unknown }>): ChatModel {
  return {
    id: "test-model",
    stream: async function* (): AsyncGenerator<AIMessageChunk> {
      yield {
        delta: { type: "text", text: "Let me use tools." },
        usage: { input: 10, output: 5 },
      };
      for (const c of calls) {
        yield {
          delta: {
            type: "tool_use",
            id: c.id,
            name: c.name,
          },
          usage: { input: 10, output: 5 },
        };
        yield {
          delta: {
            type: "input_json_delta",
            id: c.id,
            partial_json: JSON.stringify(c.input ?? {}),
          },
          usage: { input: 10, output: 5 },
        };
      }
      yield {
        delta: { type: "text", text: "" },
        stopReason: "tool_use",
        done: true,
        usage: { input: 10, output: 10 },
      };
    },
    countTokens: async () => 0,
  };
}

describe("spanLoop tool parallel execution", () => {
  test("serial tools execute in order via executeOne path", async () => {
    const calls: string[] = [];
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        calls.push("t1");
        return { content: "ok" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        calls.push("t2");
        return { content: "ok" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    await drain(spanLoop(rt, { maxSteps: 1 }));

    expect(calls).toEqual(["t1", "t2"]);
  });

  test("concurrent tools run in parallel (timing check)", async () => {
    const starts: number[] = [];
    const ends: number[] = [];

    const slow: Tool = {
      name: "slow",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 100));
        ends.push(Date.now());
        return { content: "done" };
      },
    };

    const rt = makeRt({ tools: [slow] });
    rt.model = toolUseModel([
      { id: "c1", name: "slow" },
      { id: "c2", name: "slow" },
    ]);

    await drain(spanLoop(rt, { maxSteps: 1 }));

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    // Both started before either ended = parallel
    expect(Math.max(starts[0]!, starts[1]!)).toBeLessThan(Math.min(ends[0]!, ends[1]!));
  });

  test("tool_results written in tool_use order, not completion order", async () => {
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: "t1-result" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        return { content: "t2-result" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    await drain(spanLoop(rt, { maxSteps: 1 }));

    const results = rt.thread.messages
      .filter((m) => Array.isArray(m.blocks))
      .flatMap((m) => (m.blocks as ContentBlock[]).filter(isToolResult));
    expect(results.length).toBe(2);
    expect(results[0]!.tool_use_id).toBe("c1");
    expect(results[1]!.tool_use_id).toBe("c2");
  });

  test("mixed serial+concurrent → each serial gets own batch, concurrent grouped", async () => {
    const order: string[] = [];
    const s1: Tool = {
      name: "s1",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        order.push("s1");
        return { content: "ok" };
      },
    };
    const c1: Tool = {
      name: "c1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        order.push("c1");
        return { content: "ok" };
      },
    };
    const c2: Tool = {
      name: "c2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        order.push("c2");
        return { content: "ok" };
      },
    };
    const s2: Tool = {
      name: "s2",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        order.push("s2");
        return { content: "ok" };
      },
    };

    const rt = makeRt({ tools: [s1, c1, c2, s2] });
    rt.model = toolUseModel([
      { id: "sc1", name: "s1" },
      { id: "cc1", name: "c1" },
      { id: "cc2", name: "c2" },
      { id: "sc2", name: "s2" },
    ]);

    await drain(spanLoop(rt, { maxSteps: 1 }));

    const s1Idx = order.indexOf("s1");
    const s2Idx = order.indexOf("s2");
    const c1Idx = order.indexOf("c1");
    const c2Idx = order.indexOf("c2");
    // s1 must finish before c1/c2 start (its own batch)
    expect(s1Idx).toBeLessThan(Math.min(c1Idx, c2Idx));
    // s2 runs after c1/c2 (its own batch after concurrent batch)
    expect(s2Idx).toBeGreaterThan(Math.max(c1Idx, c2Idx));
  });
});

describe("spanLoop steering", () => {
  test("steering messages appear in thread before model call", async () => {
    let modelReceivedMsgs: Message[] = [];
    const model: ChatModel = {
      id: "test-steering",
      stream: async function* (msgs: Message[]) {
        modelReceivedMsgs = [...msgs];
        yield {
          delta: { type: "text", text: "ok" },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 2 },
        };
      },
      countTokens: async () => 0,
    };

    const rt = makeRt();
    rt.model = model;

    const queue: Message[] = [{ role: "user", text: "steering: correct course" }];
    const steering: SteeringQueue = {
      drain: () => {
        const items = [...queue];
        queue.length = 0;
        return items;
      },
    };

    await drain(spanLoop(rt, { maxSteps: 1, steering }));

    expect(
      modelReceivedMsgs.some((m) =>
        (m as Message & { text?: string }).text?.includes("steering: correct course"),
      ),
    ).toBe(true);
  });

  test("no steering → spanLoop behaves identically to before", async () => {
    const rt = makeRt();
    rt.model = {
      id: "test-no-steering",
      stream: async function* () {
        yield {
          delta: { type: "text", text: "ok" },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 2 },
        };
      },
      countTokens: async () => 0,
    };

    const events: Array<{ type: string }> = [];

    for await (const _ev of spanLoop(rt, { maxSteps: 1 })) {
      events.push(_ev);
    }

    expect(events.some((e) => e.type === "message")).toBe(true);
  });

  test("follow-up messages trigger a new inner loop iteration", async () => {
    let callCount = 0;
    const model: ChatModel = {
      id: "test-followup",
      stream: async function* () {
        callCount++;
        yield {
          delta: { type: "text", text: `turn-${callCount}` },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 5 },
        };
      },
      countTokens: async () => 0,
    };

    const rt = makeRt();
    rt.model = model;

    const followUpQueue: Message[] = [{ role: "user", text: "follow-up: do more" }];
    const followUp: FollowUpQueue = {
      drain: () => {
        const items = [...followUpQueue];
        followUpQueue.length = 0;
        return items;
      },
    };

    await drain(spanLoop(rt, { maxSteps: 1, followUp }));

    // Model called twice: once for initial run, once for follow-up
    expect(callCount).toBe(2);
  });

  test("streaming model yields progressive message events", async () => {
    const model: ChatModel = {
      id: "test-streaming",
      stream: async function* (): AsyncGenerator<AIMessageChunk> {
        yield { delta: { type: "text", text: "Hello" }, usage: { input: 10, output: 1 } };
        // Simulate inter-chunk delay so throttling allows multiple yields
        await new Promise((r) => setTimeout(r, 100));
        yield { delta: { type: "text", text: " world" }, usage: { input: 10, output: 2 } };
        await new Promise((r) => setTimeout(r, 100));
        yield {
          delta: { type: "text", text: "!" },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 3 },
        };
      },
      countTokens: async () => 0,
    };

    const rt = makeRt();
    rt.model = model;

    const events: Array<{ type: string }> = [];
    for await (const ev of spanLoop(rt, { maxSteps: 1, stream: true })) {
      events.push(ev);
    }

    const messageUpdates = events.filter((e) => e.type === "message_update");
    // Should yield at least one progressive streaming update
    expect(messageUpdates.length).toBeGreaterThanOrEqual(1);
    const messageEvents = events.filter((e) => e.type === "message");
    // Should yield at least one final message (done state)
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("non-streaming model yields only final message", async () => {
    const model: ChatModel = {
      id: "test-non-streaming",
      stream: async function* () {
        yield {
          delta: { type: "text", text: "full response" },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 5 },
        };
      },
      countTokens: async () => 0,
    };

    const rt = makeRt();
    rt.model = model;

    const events: Array<{ type: string }> = [];
    for await (const ev of spanLoop(rt, { maxSteps: 1, stream: true })) {
      events.push(ev);
    }

    const messageEvents = events.filter((e) => e.type === "message");
    // One-shot model → one streaming yield (on first chunk) + final done
    expect(messageEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("no follow-up → single outer loop iteration (existing behavior)", async () => {
    let callCount = 0;
    const model: ChatModel = {
      id: "test-no-followup",
      stream: async function* () {
        callCount++;
        yield {
          delta: { type: "text", text: "done" },
          stopReason: "end_turn",
          done: true,
          usage: { input: 10, output: 5 },
        };
      },
      countTokens: async () => 0,
    };

    const rt = makeRt();
    rt.model = model;

    await drain(spanLoop(rt, { maxSteps: 2 }));

    // Without follow-up, model returns no tool_use blocks → stops at step 0
    expect(callCount).toBe(1);
  });
});

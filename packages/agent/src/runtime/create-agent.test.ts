import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, ChatModelOptions, Tool } from "@my-agent-team/core";
import type { Message, MessageRevision } from "@my-agent-team/message";
import type { InterruptState } from "../persistence/checkpointer.js";
import { InterruptSignal } from "../persistence/interrupt-store.js";
import type { AgentEvent } from "./agent-event.js";
import { createAgent } from "./create-agent.js";
import { definePlugin } from "./plugin.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function scriptedModel(
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >,
  spy?: { lastOptions?: ChatModelOptions },
): ChatModel {
  return {
    async *stream(messages, options): AsyncIterable<AIMessageChunk> {
      if (spy) spy.lastOptions = options;
      const turn = messages.filter((m) => m.role === "assistant").length;
      const item = turns[Math.min(turn, turns.length - 1)];
      if (!item) return;
      if (item.type === "text") {
        yield { delta: { type: "text", text: item.text } };
        yield { done: true, stopReason: "end_turn" };
      } else {
        yield { delta: { type: "tool_use", id: item.id, name: item.name } };
        yield {
          delta: {
            type: "input_json_delta",
            id: item.id,
            partial_json: JSON.stringify(item.input),
          },
        };
        yield { done: true, stopReason: "tool_use" };
      }
    },
  };
}

function msgPayloads(events: AgentEvent[]): MessageRevision[] {
  return events.filter((e) => e.type === "message").map((e) => e.payload as MessageRevision);
}

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: () => ({ content: "ok" }) };
}

describe("createAgent", () => {
  // ─── M3 regression ───────────────────────────────────────────

  test("single-turn text → run yields AgentEvent envelope", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    const yielded = await collect(agent.run("hi"));

    const llmCall = yielded.find(
      (e): e is Extract<(typeof yielded)[number], { type: "llm_call" }> => e.type === "llm_call",
    );
    expect(llmCall).toBeDefined();
    if (llmCall) {
      expect(llmCall.payload.step).toBe(0);
      expect(llmCall.payload.model).toBe("unknown");
      expect(llmCall.payload.usage).toEqual({
        input: 0,
        output: 0,
        cacheCreate: undefined,
        cacheRead: undefined,
      });
      expect(typeof llmCall.payload.latencyMs).toBe("number");
    }
    const msg = yielded.find(
      (e): e is Extract<(typeof yielded)[number], { type: "message" }> => e.type === "message",
    );
    expect(msg).toBeDefined();
    if (msg) {
      // M17.2: payload is now a MessageRevision (envelope with messageId/state/spanId etc.)
      const rev = msg.payload;
      expect(rev.role).toBe("assistant");
      expect(rev.state).toBe("streaming"); // First message is always streaming
      expect(rev.blocks).toEqual([{ type: "text", text: "hello" }]);
      expect(rev.messageId).toContain("span:");
      expect(rev.messageId).toContain(":assistant:0");
      expect(typeof rev.spanId).toBe("string");
      expect(typeof rev.updatedAt).toBe("number");
    }
    expect(agent.thread.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", blocks: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("auto-inserts systemPrompt on first run", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      systemPrompt: "You are helpful.",
    });

    await collect(agent.run("hi"));

    expect(agent.thread.messages[0]).toEqual({ role: "system", text: "You are helpful." });
  });

  test("does not duplicate systemPrompt across runs", async () => {
    const agent = await createAgent({
      model: scriptedModel([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
      systemPrompt: "sys",
    });

    await collect(agent.run("first"));
    await collect(agent.run("second"));

    const systemCount = agent.thread.messages.filter((m) => m.role === "system").length;
    expect(systemCount).toBe(1);
  });

  test("tool loop: executes tool and continues", async () => {
    const lookup: Tool = {
      name: "lookup",
      description: "",
      inputSchema: {},
      execute: (input) => ({ content: `result:${(input as { q: string }).q}` }),
    };

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "weather" } },
        { type: "text", text: "sunny" },
      ]),
      tools: [lookup],
    });

    await collect(agent.run("what's the weather?"));

    expect(agent.thread.messages).toHaveLength(4);
    expect(agent.thread.messages[2]?.role).toBe("user");
    expect((agent.thread.messages[3] as Message)?.role).toBe("assistant");
  });

  test("fork creates independent agent with separate thread", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
    });

    await collect(agent.run("first"));
    const forked = agent.fork();

    expect(forked.thread.id).not.toBe(agent.thread.id);
    expect(forked.thread.messages).toHaveLength(2);
    expect(forked.thread.messages).toEqual(agent.thread.messages);
    expect(forked.thread.messages).not.toBe(agent.thread.messages);
  });

  test("fork with same sessionId throws", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
    });

    expect(() => agent.fork([], agent.thread.id)).toThrow("Cannot fork with the same sessionId");
  });

  test("parallel fork does not interfere with original", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    const forked = agent.fork();
    await collect(forked.run("fork-msg"));

    expect(forked.thread.messages).toHaveLength(2);
    expect(agent.thread.messages).toHaveLength(0);
  });

  test("aborts early: signal already aborted does not push user message", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(collect(agent.run("hi", { signal: controller.signal }))).rejects.toThrow();
    expect(agent.thread.messages).toHaveLength(0);
  });

  test("checkpointer save is called after tool turn", async () => {
    let savedThreadId = "";
    let savedMessages: Message[] = [];

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "x" } },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "lookup",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: (id, msgs) => {
          savedThreadId = id;
          savedMessages = msgs.slice();
          return Promise.resolve();
        },
      },
    });

    await collect(agent.run("hi"));

    expect(savedThreadId).toBe(agent.thread.id);
    expect(savedMessages).toHaveLength(4);
  });

  test("checkpointer load recovers existing thread", async () => {
    const savedMessages: Message[] = [
      { role: "system", text: "sys" },
      { role: "user", text: "old" },
      { role: "assistant", text: "answer" },
    ];

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "new" }]),
      sessionId: "saved-thread",
      checkpointer: {
        load: (id) => {
          expect(id).toBe("saved-thread");
          return Promise.resolve(savedMessages.slice());
        },
        save: () => Promise.resolve(),
      },
    });

    expect(agent.thread.messages).toEqual(savedMessages);
  });

  test("checkpointer load returns null → empty thread", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "fresh" }]),
      sessionId: "new-thread",
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
      },
    });

    expect(agent.thread.messages).toEqual([]);
  });

  test("throws on concurrent run", async () => {
    const agent = await createAgent({
      model: {
        // eslint-disable-next-line require-yield
        async *stream() {
          await new Promise(() => {});
        },
      },
    });

    void collect(agent.run("one"));

    await expect(collect(agent.run("two"))).rejects.toThrow("already running");
  });

  test("beforeTool skip prevents execution", async () => {
    let toolExecuted = false;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "blocked", input: {} },
        { type: "text", text: "handled" },
      ]),
      tools: [
        {
          name: "blocked",
          description: "",
          inputSchema: {},
          execute: () => {
            toolExecuted = true;
            return { content: "ok" };
          },
        },
      ],
      plugins: [
        definePlugin({
          name: "guard",
          hooks: {
            beforeTool: () => ({ skip: true, result: "denied" }),
          },
        }),
      ],
    });

    await collect(agent.run("do it"));

    expect(toolExecuted).toBe(false);
    const toolResults = agent.thread.messages.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.blocks) &&
        m.blocks.some((b) => b.type === "tool_result"),
    );
    expect(toolResults).toHaveLength(1);
  });

  test("afterTool side-effect is called", async () => {
    let sideEffectCall = "";

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "log", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "done" }),
        },
      ],
      plugins: [
        definePlugin({
          name: "audit",
          hooks: {
            afterTool: (_, call) => {
              sideEffectCall = call.id;
            },
          },
        }),
      ],
    });

    await collect(agent.run("log"));

    expect(sideEffectCall).toBe("t1");
  });

  test("beforeModel error is isolated and does not break agent", async () => {
    // M2: beforeModel errors are caught and warned, not propagated
    let warnCount = 0;
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      logger: {
        warn: () => {
          warnCount++;
        },
        info: () => {},
        error: () => {},
        debug: () => {},
        level: "warn" as const,
      },
      plugins: [
        definePlugin({
          name: "explode",
          hooks: {
            beforeModel: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
    });

    const events = await collect(agent.run("hi"));
    // Agent completed normally — error was isolated, not propagated
    expect(events.some((e) => e.type === "message")).toBe(true);
    // Error was logged via warn
    expect(warnCount).toBeGreaterThan(0);
    // Model still produced the expected output despite plugin error
    // M17.2: 1 streaming + 1 terminal = 2 message events
    expect(events.filter((e) => e.type === "message").length).toBe(2);
  });

  test("afterModel error is swallowed", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "fine" }]),
      plugins: [
        definePlugin({
          name: "flaky",
          hooks: {
            afterModel: () => {
              throw new Error("unimportant");
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });

  test("maxSteps stops infinite tool loop", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "loop", input: {} }]),
      tools: [
        {
          name: "loop",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "again" }),
        },
      ],
    });

    const yielded = await collect(agent.run("go", { maxSteps: 2 }));

    // 2 steps: 2 assistant yields + tool_result pushes = 5 thread messages
    expect(agent.thread.messages).toHaveLength(5);
    // M17.2: each step emits 2 message events (model output + post-tool), plus terminal error = 5
    expect(yielded.filter((e) => e.type === "message")).toHaveLength(5);
  });

  // ─── M4: AgentEvent envelope ─────────────────────────────────

  test("AgentEvent envelope: message type wraps payload", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    for await (const ev of agent.run("hi")) {
      expect(ev).toHaveProperty("type");
      // agent_start, agent_end, and session events don't have payload
      if ("payload" in ev) {
        if (ev.type === "message") {
          expect(ev.payload).toHaveProperty("role");
        }
      }
    }
  });

  // ─── M4: Interrupt & Resume ──────────────────────────────────

  test("tool throws InterruptSignal → yields interrupted and saves state", async () => {
    let interruptSaved = false;
    const cp = {
      load: () => Promise.resolve(null as Message[] | null),
      save: () => Promise.resolve(),
      saveInterrupt: () => {
        interruptSaved = true;
        return Promise.resolve();
      },
      consumeInterrupt: () => Promise.resolve(null),
    };

    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "ask", input: {} }]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval", { risk: "high" });
          },
        },
      ],
      checkpointer: cp,
    });

    const yielded = await collect(agent.run("do it"));

    const interrupted = yielded.find((e) => e.type === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted?.payload.reason).toBe("needs approval");
    expect(interrupted?.payload.meta).toEqual({ risk: "high" });
    expect(interruptSaved).toBe(true);
    // messages include the assistant with tool_use
    const assistants = agent.thread.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  test("resume approved injects tool_result and continues", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "thanks for approving" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    // First run: triggers interrupt
    await collect(agent.run("do it"));
    // Second call: resume
    const yielded = await collect(agent.resume({ approved: true }));

    // Should have tool_result in messages
    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "tool_result"),
    );
    expect(toolResults).toHaveLength(1);

    const resultBlock = (toolResults[0]?.blocks as { type: string; is_error?: boolean }[])[0]!;
    expect(resultBlock.type).toBe("tool_result");
    expect((resultBlock as { is_error?: boolean }).is_error).toBe(false);

    // Second model response should be yielded
    const msgs = msgPayloads(yielded);
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });

  test("resume denied → tool_result is_error=true", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: false }));

    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "tool_result"),
    );
    const block = (
      toolResults[0]?.blocks as { type: string; content: string; is_error?: boolean }[]
    )[0]!;
    expect((block as { is_error?: boolean }).is_error).toBe(true);
    expect(block.content).toContain("denied");
  });

  test("resume denied with custom message", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: false, message: "Not now, try a different approach" }));

    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "tool_result"),
    );
    const block = (
      toolResults[0]?.blocks as { type: string; content: string; is_error?: boolean }[]
    )[0]!;
    expect(block.content).toBe("Not now, try a different approach");
  });

  test("resume with no pending interrupt throws", async () => {
    // Default inMemoryCheckpointer has no pending interrupt
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    await expect(collect(agent.resume({ approved: true }))).rejects.toThrow("No pending interrupt");
  });

  test("tool throws InterruptSignal but checkpointer lacks saveInterrupt → throws actionable message", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "ask", input: {} }]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        // no saveInterrupt / consumeInterrupt
      },
    });

    await expect(collect(agent.run("do it"))).rejects.toThrow("interruptStore is not configured");
  });

  // ─── H1: Multi-tool interrupt preserves tool_results ──────────

  test("H1: interrupt in multi-tool batch leaves no orphan tool_use", async () => {
    const cp = {
      load: () => Promise.resolve(null as Message[] | null),
      save: () => Promise.resolve(),
      saveInterrupt: () => Promise.resolve(),
      consumeInterrupt: () => Promise.resolve(null),
    };

    // Model returns 2 tool_use blocks in ONE assistant message — FIRST one interrupts
    let firstCall = true;
    const agent = await createAgent({
      model: {
        async *stream(_msgs): AsyncIterable<AIMessageChunk> {
          if (firstCall) {
            firstCall = false;
            yield { delta: { type: "tool_use", id: "t1", name: "ask" } };
            yield { delta: { type: "tool_use", id: "t2", name: "passthrough" } };
            yield { done: true, stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "done" } };
            yield { done: true, stopReason: "end_turn" };
          }
        },
      },
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
        {
          name: "passthrough",
          description: "",
          inputSchema: {},
          execute: () => Promise.resolve({ content: "pass" }),
        },
      ],
      checkpointer: cp,
    });

    const events = await collect(agent.run("do it"));
    expect(events.some((e) => e.type === "interrupted")).toBe(true);

    // Extract all tool_use and tool_result blocks with their ids
    const toolUses = agent.thread.messages.flatMap((m) =>
      Array.isArray(m.blocks) ? m.blocks.filter((b) => b.type === "tool_use") : [],
    ) as { type: "tool_use"; id: string }[];

    const toolResults = agent.thread.messages.flatMap((m) =>
      Array.isArray(m.blocks) ? m.blocks.filter((b) => b.type === "tool_result") : [],
    ) as { type: "tool_result"; tool_use_id: string; is_error?: boolean; content: string }[];

    const resultIds = new Set(toolResults.map((r) => r.tool_use_id));

    // t1 (the interrupting tool): R4 now gets an immediate placeholder
    expect(resultIds.has("t1")).toBe(true);
    const t1Result = toolResults.find((r) => r.tool_use_id === "t1")!;
    expect(t1Result.is_error).toBe(true);
    expect(t1Result.content).toBe("Interrupted");

    // t2 (the non-interrupting tool after the interrupt): must have placeholder tool_result
    expect(resultIds.has("t2")).toBe(true);
    const t2Result = toolResults.find((r) => r.tool_use_id === "t2")!;
    expect(t2Result.is_error).toBe(true);
    expect(t2Result.content).toBe("Interrupted");

    // No orphan tool_use: every tool_use except the interrupting one has a matching tool_result
    const interruptedId = "t1";
    for (const tu of toolUses) {
      if (tu.id === interruptedId) continue; // gets tool_result on resume
      expect(resultIds.has(tu.id)).toBe(true);
    }
  });

  test("concurrent resume throws", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));

    // Start first resume (never returns)
    void collect(agent.resume({ approved: true }));

    // Second resume should throw
    await expect(collect(agent.resume({ approved: true }))).rejects.toThrow("already running");
  });

  // ─── M4: ContextManager integration ──────────────────────────

  test("plugin.beforeModel called before ContextManager.shape", async () => {
    const calls: string[] = [];

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      contextManager: {
        shape: (_ctx, msgs) => {
          calls.push("cm");
          return [...msgs];
        },
      },
      plugins: [
        definePlugin({
          name: "test",
          hooks: {
            beforeModel: (_ctx, msgs) => {
              calls.push("plugin");
              return [...msgs];
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));

    expect(calls).toEqual(["plugin", "cm"]);
  });

  test("shape result does not pollute thread.messages", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
      contextManager: {
        shape: (_ctx, _msgs) => {
          // return different messages than what's in thread
          return [
            { role: "system", text: "fake" },
            { role: "user", text: "fake" },
          ];
        },
      },
    });

    await collect(agent.run("hi"));

    // thread.messages still has the real messages, not shape output
    expect(agent.thread.messages[0]?.role).toBe("user");
    expect(agent.thread.messages[0]?.text).toBe("hi");
  });

  test("default ContextManager is passthrough", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    await collect(agent.run("hi"));

    expect(agent.thread.messages).toHaveLength(2);
  });

  // ─── M4: Logger integration ──────────────────────────────────

  test("framework uses injected logger", async () => {
    const warnings: string[] = [];
    const logger = {
      level: "warn" as const,
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    };

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [
        definePlugin({
          name: "flaky",
          hooks: {
            afterModel: () => {
              throw new Error("unimportant");
            },
          },
        }),
      ],
      logger,
    });

    await collect(agent.run("hi"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  // ─── M4: HookContext exposes three capabilities ───────────────

  test("HookContext exposes logger, messageStore, contextManager", async () => {
    let hookCtx: unknown = null;

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [
        definePlugin({
          name: "inspector",
          hooks: {
            beforeModel: (ctx, msgs) => {
              hookCtx = ctx;
              return [...msgs];
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));

    expect(hookCtx).toHaveProperty("sessionId");
    expect(hookCtx).toHaveProperty("logger");
    expect(hookCtx).toHaveProperty("messageStore");
    expect(hookCtx).toHaveProperty("contextManager");
  });

  // ─── M4: appendEvent ─────────────────────────────────────────

  test("appendEvent called for key events", async () => {
    const events: { type: string }[] = [];

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "log", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        appendEvent: (_id, _spanId, event) => {
          events.push({ type: event.type });
          return Promise.resolve();
        },
        readEvents: async function* () {},
      },
    });

    await collect(agent.run("hi"));

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("user_input");
    expect(eventTypes).toContain("model_start");
    expect(eventTypes).toContain("model_end");
    expect(eventTypes).toContain("tool_start");
    expect(eventTypes).toContain("tool_end");
    expect(eventTypes).toContain("run_end");
  });

  test("appendEvent called on interrupt and resume", async () => {
    const events: { type: string }[] = [];
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("wait");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
        appendEvent: (_id, _spanId, event) => {
          events.push({ type: event.type });
          return Promise.resolve();
        },
        readEvents: async function* () {},
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: true }));

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("interrupt");
    expect(eventTypes).toContain("resume");
  });

  // ─── M4: beforeTool InterruptSignal NOT recognized ────────────

  test("beforeTool error is isolated and does not interrupt agent", async () => {
    // M2: beforeTool errors (including InterruptSignal) are caught and warned, NOT treated as interrupt
    let warnCount = 0;
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "log", input: {} }]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      plugins: [
        definePlugin({
          name: "bad",
          hooks: {
            beforeTool: () => {
              throw new InterruptSignal("should not work here");
            },
          },
        }),
      ],
      logger: {
        warn: () => {
          warnCount++;
        },
        info: () => {},
        error: () => {},
        debug: () => {},
        level: "warn" as const,
      },
    });

    const events = await collect(agent.run("hi"));
    // No interrupted event — InterruptSignal was neutralized, not treated as interrupt
    expect(events.some((e) => e.type === "interrupted")).toBe(false);
    // Tool still executed: find a tool_result for t1 with no error flag
    const toolResults = agent.thread.messages.flatMap((m) =>
      Array.isArray(m.blocks) ? m.blocks.filter((b) => b.type === "tool_result") : [],
    ) as { type: "tool_result"; tool_use_id: string; is_error?: boolean }[];
    const t1Result = toolResults.find((r) => r.tool_use_id === "t1");
    expect(t1Result).toBeDefined();
    expect(t1Result?.is_error).toBeUndefined();
    // Error was logged
    expect(warnCount).toBeGreaterThan(0);
  });

  // ─── M4: Checkpointer paired validation ──────────────────────

  test("createAgent throws on unpaired appendEvent", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        checkpointer: {
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          appendEvent: () => Promise.resolve(),
          // no readEvents
        },
      }),
    ).rejects.toThrow("event capability is partial");
  });

  test("createAgent throws on unpaired saveInterrupt", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        checkpointer: {
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          saveInterrupt: () => Promise.resolve(),
          // no consumeInterrupt
        },
      }),
    ).rejects.toThrow("interrupt capability is partial");
  });

  // ─── M5: Plugin.tools merge ──────────────────────────────────

  test("plugin tools are merged into agent tool set", async () => {
    const agent2 = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "p1_b", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [makeTool("config_a")],
      plugins: [
        definePlugin({
          name: "p1",
          hooks: {},
          tools: [makeTool("p1_a"), makeTool("p1_b")],
        }),
      ],
    });

    // tool from plugin should be found and executed without "Tool not found"
    await collect(agent2.run("go"));
    const toolResults = agent2.thread.messages.filter(
      (m) =>
        Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "tool_result" && b.is_error),
    );
    expect(toolResults).toHaveLength(0);
  });

  test("duplicate tool name between config and plugin throws at startup", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        tools: [makeTool("read")],
        plugins: [
          definePlugin({
            name: "p1",
            hooks: {},
            tools: [makeTool("read")],
          }),
        ],
      }),
    ).rejects.toThrow("Tool name collision");
  });

  test("duplicate tool name between two plugins throws at startup", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        plugins: [
          definePlugin({ name: "a", hooks: {}, tools: [makeTool("x")] }),
          definePlugin({ name: "b", hooks: {}, tools: [makeTool("x")] }),
        ],
      }),
    ).rejects.toThrow("Tool name collision");
  });

  test("plugin without tools does not cause issues", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
      plugins: [definePlugin({ name: "bare", hooks: {} })],
    });

    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });

  test("config tools and plugin tools are merged without conflicts", async () => {
    // Verify agent creation succeeds with both config and plugin tools,
    // and that the merged tool set works in a run
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "first", input: {} }]),
      tools: [makeTool("first"), makeTool("second")],
      plugins: [
        definePlugin({
          name: "p1",
          hooks: {},
          tools: [makeTool("third")],
        }),
      ],
    });

    const events = await collect(agent.run("hi"));
    expect(events.some((e) => e.type === "message")).toBe(true);
  });

  test("B1: tools are forwarded to model.stream options", async () => {
    const spy: { lastOptions?: ChatModelOptions } = {};
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }], spy),
      tools: [makeTool("bash")],
    });
    await collect(agent.run("hi"));
    expect(spy.lastOptions?.tools?.map((t: Tool) => t.name)).toContain("bash");
  });

  // ─── M17.2: MessageRevision envelope ───────────────────────

  test("message event payload is a valid MessageRevision with messageId and spanId", async () => {
    const spanId = "test-run-1";
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    const events = await collect(agent.run("hi", { spanId }));
    const msgEvents = events.filter((e) => e.type === "message");

    // At least streaming + terminal
    expect(msgEvents.length).toBeGreaterThanOrEqual(2);

    // Terminal revision has state "done"
    const terminal = msgEvents[msgEvents.length - 1]!;
    expect(terminal.payload.state).toBe("done");
    expect(terminal.payload.messageId).toBe(`span:${spanId}:assistant:0`);
    expect(terminal.payload.role).toBe("assistant");
    expect(terminal.payload.spanId).toBe(spanId);
    expect(typeof terminal.payload.updatedAt).toBe("number");
    expect(terminal.payload.visibility).toBe("conversation");
  });

  test("streaming phase state is 'streaming' and messageId is constant", async () => {
    const spanId = "stream-run";
    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "x" } },
        { type: "text", text: "found" },
      ]),
      tools: [makeTool("lookup")],
    });

    const events = await collect(agent.run("go", { spanId }));
    const msgEvents = events.filter((e) => e.type === "message");

    // M17.4 (Patch C v3): one run = one growing assistant message.
    // All revisions share the same messageId; ordinal is reserved.
    for (const ev of msgEvents) {
      expect(ev.payload.messageId).toBe(`span:${spanId}:assistant:0`);
    }

    // Non-terminal message events have state "streaming" or "waiting"
    const nonTerminal = msgEvents.filter(
      (e) => e.payload.state !== "done" && e.payload.state !== "error",
    );
    expect(nonTerminal.length).toBeGreaterThan(0);
    for (const ev of nonTerminal) {
      expect(["streaming", "waiting"]).toContain(ev.payload.state);
    }

    // Last event is terminal (done)
    const last = msgEvents[msgEvents.length - 1]!;
    expect(last.payload.state).toBe("done");
  });

  test("K-turn run — all intermediate revisions have terminal follow-up, no open segments left", async () => {
    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "a" } },
        { type: "tool_call", id: "t2", name: "lookup", input: { q: "b" } },
        { type: "text", text: "done" },
      ]),
      tools: [makeTool("lookup")],
    });

    const events = await collect(agent.run("go"));
    const msgEvents = events.filter((e) => e.type === "message");

    // All revisions belong to the same message (single growing bubble).
    const ids = new Set(msgEvents.map((e) => e.payload.messageId));
    expect(ids.size).toBe(1);

    // Final state must be terminal — no open segments left behind.
    const last = msgEvents[msgEvents.length - 1]!;
    expect(last.payload.state).toBe("done");
  });

  test("run normal completion emits state 'done' terminal", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "all done" }]),
    });

    const events = await collect(agent.run("hi"));
    const msgEvents = events.filter((e) => e.type === "message");
    const terminal = msgEvents[msgEvents.length - 1]!;
    expect(terminal.payload.state).toBe("done");
  });

  test("auto-generates spanId when not passed", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    const events = await collect(agent.run("hi"));
    const msgEvents = events.filter((e) => e.type === "message");

    // spanId is auto-generated (random UUID, not thread.id)
    expect(msgEvents[0]!.payload.spanId).toBeDefined();
    expect(msgEvents[0]!.payload.spanId).not.toBe(agent.thread.id);
    expect(msgEvents[0]!.payload.messageId).toBe(
      `span:${msgEvents[0]!.payload.spanId}:assistant:0`,
    );
  });

  test("tool-only run still emits terminal", async () => {
    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "x" } },
        // No text — tool-only, model returns empty after tools
      ]),
      tools: [makeTool("lookup")],
    });

    // Use maxSteps=1 to stop after tool execution (no second model call)
    const events = await collect(agent.run("go", { maxSteps: 1 }));
    const msgEvents = events.filter((e) => e.type === "message");

    // Should have: step0-message + post-tool-message + terminal-error (maxSteps)
    expect(msgEvents.length).toBeGreaterThanOrEqual(1);

    // Check that tools appear in payload.tools[]
    const withTools = msgEvents.filter((e) => e.payload.tools && e.payload.tools.length > 0);
    expect(withTools.length).toBeGreaterThan(0);
    // Tools state should be populated
    for (const ev of withTools) {
      for (const t of ev.payload.tools ?? []) {
        expect(t.id).toBe("t1");
        expect(t.name).toBe("lookup");
        expect(["running", "done", "error"]).toContain(t.state);
      }
    }
  });

  test("AgentEvent no longer exposes text_delta/reasoning_delta/tool_start/tool_end", async () => {
    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [makeTool("lookup")],
    });

    const events = await collect(agent.run("go"));
    const eventTypes = new Set<string>(events.map((e) => e.type));

    // These legacy event types must not appear
    expect(eventTypes.has("text_delta" as string)).toBe(false);
    expect(eventTypes.has("reasoning_delta" as string)).toBe(false);
    expect(eventTypes.has("tool_start" as string)).toBe(false);
    expect(eventTypes.has("tool_end" as string)).toBe(false);

    // observability and control still present
    expect(eventTypes.has("tool_call")).toBe(true);
    expect(eventTypes.has("llm_call")).toBe(true);
    expect(eventTypes.has("message")).toBe(true);
  });
});

// ─── Agent.subscribe() ─────────────────────────────────────────

describe("Agent.subscribe()", () => {
  test("notifies subscriber on each event", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });
    const events: string[] = [];
    const unsub = agent.subscribe((e) => events.push(e.type));

    await collect(agent.run("hi"));

    unsub();
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("message");
    expect(events).toContain("llm_call");
  });

  test("unsubscribe stops notifications", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });
    const events: string[] = [];
    const unsub = agent.subscribe((e) => events.push(e.type));
    unsub();

    await collect(agent.run("hi"));

    expect(events.length).toBe(0);
  });

  test("multiple subscribers all notified", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = agent.subscribe((e) => a.push(e.type));
    const unsubB = agent.subscribe((e) => b.push(e.type));

    await collect(agent.run("hi"));

    unsubA();
    unsubB();
    expect(a.length).toBe(b.length);
    expect(a).toContain("message");
    expect(b).toContain("message");
  });

  test("forked agent has independent subscribers", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });
    const parentEvents: string[] = [];
    agent.subscribe((e) => parentEvents.push(e.type));

    const child = agent.fork();
    const childEvents: string[] = [];
    child.subscribe((e) => childEvents.push(e.type));

    await collect(agent.run("parent"));
    await collect(child.run("child"));

    // Parent subscriber was not fired for child events
    // and vice versa. Both got their own.
    expect(parentEvents.length).toBeGreaterThan(0);
    expect(childEvents.length).toBeGreaterThan(0);
    // Each only got events matching their own run's message content pattern
    // (this is implicit from independence — detailed content check isn't needed)
  });
});

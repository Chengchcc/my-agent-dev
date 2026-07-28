import { describe, expect, test } from "bun:test";
import type { Tool, ToolUseBlock } from "@my-agent-team/core";
import { createContextStore } from "../context/context.js";
import { passthroughContextManager } from "../context/passthrough.js";
import { inMemoryCheckpointer } from "../persistence/in-memory.js";
import { memorySessionStorage } from "../persistence/memory-session-storage.js";
import { Session } from "../persistence/session.js";
import type { AgentRuntime } from "./agent-options.js";
import { runOneCollect } from "./execute-one.js";
import { consoleLogger } from "./logger.js";
import { createPluginRunner } from "./plugin-dispatcher.js";
import { createThread } from "./thread.js";

function makeRuntime(tools: Tool[] = []): AgentRuntime {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const checkpointer = inMemoryCheckpointer();
  const logger = consoleLogger({ level: "silent" });
  return {
    thread: createThread([], "t1"),
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

const testCall: ToolUseBlock = {
  type: "tool_use",
  id: "call-1",
  name: "echo",
  input: { msg: "hello" },
};

describe("runOneCollect", () => {
  test("returns resultBlock with tool output", async () => {
    const echo: Tool = {
      name: "echo",
      description: "echoes input",
      inputSchema: { type: "object", properties: {} },
      execute: async (input) => ({ content: JSON.stringify(input) }),
    };
    const rt = makeRuntime([echo]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.content).toContain("hello");
    expect(result.events.length).toBe(2);
    expect(result.events[0]?.type).toBe("tool_execution_start");
    expect(result.events[1]?.type).toBe("tool_call");
  });

  test("returns isError when tool throws", async () => {
    const bad: Tool = {
      name: "echo",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("boom");
      },
    };
    const rt = makeRuntime([bad]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.is_error).toBe(true);
    expect(result.resultBlock.content).toBe("boom");
  });

  test("tool not found → error result", async () => {
    const rt = makeRuntime([]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.is_error).toBe(true);
    expect(result.resultBlock.content).toContain("Tool not found");
  });
});

import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createOmaSession } from "./agent-loop.js";

const LOOP_RUN = {
  runId: "r-content",
  model: { backendKind: "oma" as const, modelId: "fake/echo" },
  configRevision: 1,
};

function loopInput(text: string) {
  return {
    input: { inputId: `in-${text}`, message: { role: "user" as const, text } },
    run: LOOP_RUN,
    workspace: { root: "/tmp", access: "read_write" as const },
  };
}

interface ToolBlock {
  type: string;
  content?: string;
}

async function runWithTool(
  toolExecute: () => Promise<Record<string, unknown>>,
): Promise<string | undefined> {
  const store = createInMemorySessionStore();
  const tool = {
    name: "fmt",
    description: "tool under test",
    executionMode: "concurrent" as const,
    execute: toolExecute,
  };
  let turn = 0;
  await store.create({
    sessionId: "s-content",
    backendKind: "oma",
    workspaceRoot: "/tmp",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const session = createOmaSession({
    sessionId: "s-content",
    store,
    plugins: [{ name: "p", tools: [tool] }],
    maxSteps: 2,
    maxForceContinues: 0,
    summarize: async () => "sum",
    modelStream: async function* (): AsyncIterable<AIMessageChunk> {
      turn++;
      if (turn === 1) {
        yield { delta: { type: "tool_use", id: "tc-1", name: "fmt" } };
        yield { stopReason: "tool_use" };
      } else {
        yield { delta: { type: "text", text: "done" } };
      }
    },
  });
  await session.startLoop(loopInput("go") as never);
  const snap = await store.open("s-content");
  const toolMsg = snap.entries.find(
    (e) =>
      (e as { type?: string }).type === "message" &&
      (e as { message?: Message }).message?.role === "tool",
  ) as unknown as { message: Message & { blocks: ToolBlock[] } };
  return toolMsg.message.blocks.find((b) => b.type === "tool_result")?.content;
}

describe("tool result content contract", () => {
  test("a result with string content becomes the tool_result text verbatim", async () => {
    const content = await runWithTool(async () => ({
      content: "SUMMARY ONLY",
      rows: [1, 2, 3],
    }));
    expect(content).toBe("SUMMARY ONLY");
  });

  test("a result without content stays a JSON dump", async () => {
    const content = await runWithTool(async () => ({ rows: [1] }));
    expect(content).toBe(JSON.stringify({ rows: [1] }));
  });
});

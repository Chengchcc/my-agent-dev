import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createOmaSession } from "./agent-loop.js";

const LOOP_RUN = {
  runId: "r-gate",
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

function probeTool() {
  return {
    name: "probe",
    description: "probe tool",
    executionMode: "concurrent" as const,
    async execute(): Promise<Record<string, unknown>> {
      return { content: "executed" };
    },
  };
}

/** Session whose model calls `probe` on turn 1, then stops. Returns the
 *  loop's tool_result text afterwards. */
async function runWithGate(
  gate: (toolName: string) => Promise<{ block: boolean; reason?: string }>,
): Promise<{ content: string; executed: boolean }> {
  let executed = false;
  const store = createInMemorySessionStore();
  await store.create({
    sessionId: "s-gate",
    backendKind: "oma",
    workspaceRoot: "/tmp",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const session = createOmaSession({
    sessionId: "s-gate",
    store,
    plugins: [
      {
        name: "p",
        tools: [
          {
            ...probeTool(),
            async execute(): Promise<Record<string, unknown>> {
              executed = true;
              return { content: "executed" };
            },
          },
        ],
      },
    ],
    maxSteps: 2,
    maxForceContinues: 0,
    summarize: async () => "s",
    permissionGate: gate,
    modelStream: async function* (): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "tool_use", id: "tc-1", name: "probe" } };
      yield { stopReason: "tool_use" };
    },
  });
  await session.startLoop(loopInput("go"));
  const snap = await store.open("s-gate");
  const toolEntry = snap.entries.find(
    (e): e is Extract<typeof e, { type: "message" }> =>
      e.type === "message" && e.message.role === "tool",
  );
  const content = toolEntry?.message.blocks.find((b) => b.type === "tool_result")?.content ?? "";
  return { content, executed };
}

describe("loop-level permission gate (M8)", () => {
  test("a throwing gate fails CLOSED: tool result is an error, tool never ran", async () => {
    const { content, executed } = await runWithGate(async () => {
      throw new Error("classifier OOM");
    });
    expect(executed).toBe(false);
    expect(content).toContain("permission gate error");
    expect(content).toContain("classifier OOM");
  });

  test("a blocking gate still blocks with its own reason", async () => {
    const { content, executed } = await runWithGate(async () => ({
      block: true,
      reason: "deny probe",
    }));
    expect(executed).toBe(false);
    expect(content).toContain("deny probe");
  });
});

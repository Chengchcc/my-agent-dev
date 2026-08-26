import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createOmaSession } from "./agent-loop.js";
import type { ApprovalDecision } from "./approval.js";

const LOOP_RUN = {
  runId: "r-appr",
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

/** A plugin tool that asks the human before acting. */
function askingTool(
  seen: string[],
  handler?: (req: { reason?: string }) => Promise<ApprovalDecision | null>,
) {
  return {
    name: "asker",
    description: "asks before acting",
    executionMode: "concurrent" as const,
    async execute(
      _args: unknown,
      _signal?: AbortSignal,
      options?: {
        callId?: string;
        onOutput?: (t: string) => void;
        request?: (req: { reason?: string }) => Promise<ApprovalDecision | null>;
      },
    ): Promise<Record<string, unknown>> {
      if (!options?.request) return { content: "no pipeline; proceeded" };
      const verdict = await options.request({ reason: "about to act" });
      if (!verdict || verdict.decision === "deny") {
        return { error: `denied: ${verdict?.reason ?? "no verdict"}`, isError: true };
      }
      seen.push(options.callId ?? "?");
      return { content: "acted" };
    },
    ...(handler ? { _handler: handler } : {}),
  };
}

async function runSession(
  toolHandler: undefined | ((req: { reason?: string }) => Promise<ApprovalDecision | null>),
  approvalHandler?: (req: { toolName: string }) => Promise<ApprovalDecision>,
) {
  const store = createInMemorySessionStore();
  await store.create({
    sessionId: "s-appr",
    backendKind: "oma",
    workspaceRoot: "/tmp",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const seen: string[] = [];
  let turn = 0;
  const session = createOmaSession({
    sessionId: "s-appr",
    store,
    plugins: [{ name: "p", tools: [askingTool(seen, toolHandler)] }],
    maxSteps: 2,
    maxForceContinues: 0,
    summarize: async () => "s",
    ...(approvalHandler ? { approvalHandler } : {}),
    modelStream: async function* (): AsyncIterable<AIMessageChunk> {
      turn++;
      if (turn === 1) {
        yield { delta: { type: "tool_use", id: "tc-1", name: "asker" } };
        yield { stopReason: "tool_use" };
      } else {
        yield { delta: { type: "text", text: "done" } };
      }
    },
  });
  await session.startLoop(loopInput("go") as never);
  const snap = await store.open("s-appr");
  const toolMsg = snap.entries.find(
    (e) =>
      (e as { type?: string }).type === "message" &&
      (e as { message?: { role?: string } }).message?.role === "tool",
  ) as unknown as { message: { blocks: Array<{ type: string; content?: string }> } };
  const content = toolMsg.message.blocks.find((b) => b.type === "tool_result")?.content ?? "";
  return { content, seen };
}

describe("approval request wiring in the loop", () => {
  test("handler deny: the tool's options.request resolves deny and the result is an error", async () => {
    const { content, seen } = await runSession(undefined, async (req) => ({
      decision: "deny",
      reason: `${req.toolName}: not on my watch`,
    }));
    expect(content).toContain("denied");
    expect(content).toContain("not on my watch");
    expect(seen).toEqual([]);
  });

  test("handler allow: the tool proceeds", async () => {
    const { content, seen } = await runSession(undefined, async () => ({ decision: "allow" }));
    expect(content).toContain("acted");
    expect(seen).toHaveLength(1);
  });

  test("no handler: options.request is absent (tool decides)", async () => {
    const { content } = await runSession(undefined, undefined);
    expect(content).toContain("no pipeline; proceeded");
  });
});

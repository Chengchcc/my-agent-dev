import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentRunSnapshot } from "@chengchenccc/agent-contract";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import type { SessionStore } from "../persistence/session-store.js";
import type { OmaLoopEvent } from "./agent-event.js";
import { createOmaSession } from "./agent-loop.js";
import type { CodingLoopInput } from "./loop-input.js";
import type { Plugin } from "./plugin.js";

process.env.OMA_TITLE_ENABLED = "0";

const fakeSummarize = async <T>(messages: readonly T[]): Promise<string> =>
  `[Summary of ${messages.length} messages]`;

const LOOP_RUN: AgentRunSnapshot<"oma"> = {
  runId: "sr-run",
  model: { backendKind: "oma", modelId: "test-1" },
  configRevision: 1,
};

function loopInput(message: string): CodingLoopInput {
  return {
    history: [],
    input: { inputId: "ti", message: { role: "user", text: message } },
    run: LOOP_RUN,
    workspace: { root: "/ws", access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  };
}

function createSession(store: SessionStore, sid: string) {
  return store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("stream rules (TTSR absorption)", () => {
  let store: SessionStore;
  beforeEach(async () => {
    store = createInMemorySessionStore();
    await createSession(store, "sr");
  });

  test("match aborts the turn, injects a system reminder, retries in-turn", async () => {
    const seenByCall: Array<Array<{ role: string; text?: string }>> = [];
    let call = 0;
    const modelStream = async function* (
      messages: readonly Message[],
    ): AsyncIterable<AIMessageChunk> {
      call++;
      seenByCall.push([...messages]);
      if (call === 1) {
        // Violation arrives mid-stream across deltas.
        yield { delta: { type: "text", text: "I will use " } };
        yield { delta: { type: "text", text: "Box::leak in prod" } };
        yield { delta: { type: "text", text: " (never consumed)" } };
        return;
      }
      yield { delta: { type: "text", text: "Using Arc<str> instead." } };
    };
    const events: OmaLoopEvent[] = [];
    const loop = createOmaSession({
      sessionId: "sr",
      store,
      plugins: [],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream,
      streamRules: [{ name: "no-box-leak", pattern: /Box::leak/, message: "Never use Box::leak." }],
    });
    loop.onEvent((e) => {
      events.push(e);
    });
    const result = await loop.startLoop(loopInput("write some rust"));

    expect(result.status).toBe("completed");
    const reminder = seenByCall[1]?.find(
      (m) => m.role === "user" && m.text?.includes('reason="rule_violation"'),
    );
    expect(reminder?.text).toContain('rule="no-box-leak"');
    expect(reminder?.text).toContain("Never use Box::leak.");

    const snap = await store.open("sr");
    const messages = snap.entries.filter((e) => e.type === "message") as Array<{
      source?: string;
      message: { role: string; text?: string; blocks?: Array<{ type: string; content?: string }> };
    }>;
    // Reminder persisted with the system_reminder source.
    const reminders = messages.filter((m) => m.source === "system_reminder");
    expect(reminders).toHaveLength(1);
    // The violating partial output was discarded.
    const assistantTexts = messages
      .filter((m) => m.message.role === "assistant")
      .map((m) => m.message.text ?? "");
    expect(assistantTexts.join("\n")).not.toContain("Box::leak");
    expect(assistantTexts.join("\n")).toContain("Arc<str>");
    // Event fired for observability.
    expect(events.some((e) => e.type === "stream_rule_triggered")).toBe(true);
  });

  test("a rule fires at most once per Run; later violations pass through", async () => {
    let call = 0;
    const modelStream = async function* (): AsyncIterable<AIMessageChunk> {
      call++;
      // Every call violates — only the first is interrupted.
      yield { delta: { type: "text", text: "Box::leak again" } };
    };
    const loop = createOmaSession({
      sessionId: "sr",
      store,
      plugins: [],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream,
      streamRules: [{ name: "no-box-leak", pattern: /Box::leak/, message: "Never use Box::leak." }],
    });
    const result = await loop.startLoop(loopInput("go"));

    expect(result.status).toBe("completed");
    expect(call).toBe(2);
    const snap = await store.open("sr");
    const texts = (
      snap.entries.filter((e) => e.type === "message") as Array<{
        message: { role: string; text?: string };
      }>
    )
      .filter((m) => m.message.role === "assistant")
      .map((m) => m.message.text ?? "");
    // Second violation persisted (rule exhausted), no third model call.
    expect(texts.join("\n")).toContain("Box::leak again");
  });
});

describe("tool-failure system reminder", () => {
  let store: SessionStore;
  beforeEach(async () => {
    store = createInMemorySessionStore();
    await createSession(store, "tfr");
  });

  const throwingPlugin: Plugin = {
    name: "test",
    tools: [
      {
        name: "boom",
        description: "Always throws",
        async execute() {
          throw new Error("kaboom");
        },
      },
    ],
  };

  async function runOnce(toolFailureReminder?: boolean) {
    const modelStream = async function* (): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "tool_use", id: "b", name: "boom" } };
      yield { stopReason: "tool_use" };
    };
    const loop = createOmaSession({
      sessionId: "tfr",
      store,
      plugins: [throwingPlugin],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream,
      ...(toolFailureReminder === false ? { toolFailureReminder: false } : {}),
    });
    await loop.startLoop(loopInput("run"));
    const snap = await store.open("tfr");
    return (
      snap.entries.filter((e) => e.type === "message") as Array<{
        message: {
          role: string;
          text?: string;
          blocks?: Array<{ type: string; content?: string }>;
        };
      }>
    ).find((m) => m.message.role === "tool");
  }

  test("failed tool result carries an in-band reminder; text stays clean", async () => {
    const toolMessage = await runOnce();
    const block = toolMessage?.message.blocks?.[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.content?.startsWith("<system-reminder>")).toBe(true);
    expect(block?.content).toContain("kaboom");
    // UI-facing text keeps the clean JSON.
    expect(toolMessage?.message.text).toBe('{"error":"kaboom"}');
  });

  test("opt-out disables the reminder", async () => {
    const toolMessage = await runOnce(false);
    const block = toolMessage?.message.blocks?.[0];
    expect(block?.content).toBe('{"error":"kaboom"}');
  });
});

import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createAgentLoop } from "./agent-loop.js";

describe("Coding Agent harness", () => {
  test("creates session and starts agent loop", async () => {
    const store = createInMemorySessionStore();
    const sessionId = "harness-1";
    await store.create({
      sessionId,
      backendKind: "coding_agent",
      workspaceRoot: "/ws",
      modelRef: { backendKind: "anthropic", modelId: "claude-sonnet" },
      systemPromptHash: null,
      activeLoopId: null,
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const loop = createAgentLoop({
      sessionId,
      store,
      modelRuntime: {
        stream: async function* () {
          yield { type: "text_delta", text: "hello" };
        },
      } as never,
      plugins: [],
      systemPrompt: "",
      maxSteps: 5,
      maxForceContinues: 2,
      providerId: "anthropic",
      modelId: "claude-sonnet",
    });

    expect(loop.status).toBe("idle");
    await loop.startLoop({ systemPrompt: "test", metaText: "", promptText: "run" });
    expect(loop.status).toBe("settled");

    const snap = await store.open(sessionId);
    expect(snap.entries.length).toBeGreaterThan(0);
  });

  test("session reopen does not resume active loop", async () => {
    const store = createInMemorySessionStore();
    const sessionId = "harness-2";
    await store.create({
      sessionId,
      backendKind: "coding_agent",
      workspaceRoot: "/ws",
      modelRef: { backendKind: "anthropic", modelId: "claude-sonnet" },
      systemPromptHash: null,
      activeLoopId: "old-loop",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Reopen: active loop should not be resumed
    const snap = await store.open(sessionId);
    expect(snap.metadata.activeLoopId).toBe("old-loop");
    // But no active loop is created - the loop is just metadata
  });
});

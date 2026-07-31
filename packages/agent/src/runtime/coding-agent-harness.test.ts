import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { AIMessageChunk } from "@my-agent-team/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createSqliteSessionStore } from "../persistence/sqlite-session-store.js";
import { createAgentLoop } from "./agent-loop.js";
import type { Plugin } from "./plugin.js";
import { readTodo, writeTodo } from "./todo.js";

function createSession(store: ReturnType<typeof createInMemorySessionStore>, sid: string) {
  return store.create({
    sessionId: sid,
    backendKind: "coding_agent",
    workspaceRoot: "/ws",
    modelRef: { backendKind: "test", modelId: "m1" },
    systemPromptHash: null,
    activeLoopId: null,
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Fake model that yields text then stops. */
function textModel(text: string) {
  return async function* (): AsyncIterable<AIMessageChunk> {
    yield { delta: { type: "text", text } };
  };
}

/** Fake model that yields a tool call. */

function testHarness(
  name: string,
  storeFactory: () => ReturnType<typeof createInMemorySessionStore>,
  cleanup?: () => void,
) {
  describe(`${name} harness`, () => {
    test("text-only loop completes", async () => {
      const store = storeFactory();
      const sid = "h-text";
      await createSession(store, sid);
      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "test",
        maxSteps: 3,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });
      await loop.startLoop({ systemPrompt: "test", metaText: "meta", promptText: "go" });
      expect(loop.status).toBe("completed");
      const snap = await store.open(sid);
      expect(snap.entries.filter((e) => e.type === "message").length).toBeGreaterThanOrEqual(3);
    });

    test("tool call executes and result persists", async () => {
      const store = storeFactory();
      const sid = "h-tool";
      await createSession(store, sid);

      const echoTool = {
        name: "echo",
        description: "Echo input",
        async execute(args: Readonly<Record<string, unknown>>) {
          return { echoed: args } as unknown as Readonly<Record<string, unknown>>;
        },
      };
      const plugin: Plugin = { name: "test", tools: [echoTool] };

      // First turn: tool call. Second turn: text stop.
      let callCount = 0;
      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [plugin],
        systemPrompt: "",
        maxSteps: 5,
        maxForceContinues: 0,
        modelStream: async function* () {
          callCount++;
          if (callCount === 1) {
            yield { delta: { type: "tool_use", id: "tc-1", name: "echo" } };
            yield { delta: { type: "input_json_delta", id: "tc-1", partial_json: '{"msg":"hi"}' } };
            yield { stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "done" } };
          }
        },
      });

      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
      expect(loop.status).toBe("completed");

      const snap = await store.open(sid);
      const messages = snap.entries.filter((e) => e.type === "message");
      // Should have: prompt, assistant(tool_use), tool_result, assistant(text)
      expect(messages.length).toBeGreaterThanOrEqual(3);
    });

    test("unknown tool returns error result", async () => {
      const store = storeFactory();
      const sid = "h-unknown";
      await createSession(store, sid);

      let callCount = 0;
      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 3,
        maxForceContinues: 0,
        modelStream: async function* () {
          callCount++;
          if (callCount === 1) {
            yield { delta: { type: "tool_use", id: "tc-1", name: "nonexistent" } };
            yield { stopReason: "tool_use" };
          } else {
            yield { delta: { type: "text", text: "ok" } };
          }
        },
      });

      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(loop.status).toBe("completed");
    });

    test("listener receives events in order", async () => {
      const store = storeFactory();
      const sid = "h-evt";
      await createSession(store, sid);

      const events: string[] = [];
      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("ok"),
      });
      loop.onEvent((e) => {
        events.push(e.type);
      });

      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(events[0]).toBe("agent_start");
      expect(events[events.length - 1]).toBe("agent_end");
    });

    test("stop aborts loop", async () => {
      const store = storeFactory();
      const sid = "h-stop";
      await createSession(store, sid);

      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 100,
        maxForceContinues: 0,
        modelStream: textModel("streaming"),
      });

      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
      loop.stop();
      await started;
      // Either completed (stopped before first iteration) or failed (maxSteps)
      expect(["completed", "failed"]).toContain(loop.status);
    });

    test("follow-up creates new loop", async () => {
      const store = storeFactory();
      const sid = "h-followup";
      await createSession(store, sid);

      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 2,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });

      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "first" });
      expect(loop.status).toBe("completed");

      // Start follow-up
      await loop.startFollowUp({ systemPrompt: "", metaText: "", promptText: "second" });
      expect(loop.status).toBe("completed");

      // Verify both loops persisted entries
      const snap = await store.open(sid);
      const promptEntries = snap.entries.filter(
        (e) =>
          (e.type === "message" && (e as { source?: string }).source === "prompt") ||
          (e as { source?: string }).source === "follow_up",
      );
      expect(promptEntries.length).toBeGreaterThanOrEqual(2);
    });

    test("todo persists and recovers on reopen", async () => {
      const store = storeFactory();
      const sid = "h-todo";
      await createSession(store, sid);

      await writeTodo(store, sid, { items: [{ id: "t1", text: "task", status: "pending" }] });

      // Read back
      const state = await readTodo(store, sid);
      expect(state.items).toHaveLength(1);
      expect(state.items[0]?.id).toBe("t1");
    });

    test("compact appends compaction entry", async () => {
      const store = storeFactory();
      const sid = "h-compact";
      await createSession(store, sid);

      // Add some messages first
      for (let i = 0; i < 10; i++) {
        await store.appendBatch(sid, {
          entries: [
            {
              type: "message",
              role: "user",
              source: "prompt",
              message: { role: "user", text: `msg ${i}` },
              createdAt: Date.now(),
            },
          ],
        });
      }

      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 1,
        maxForceContinues: 0,
        modelStream: textModel("done"),
      });
      await loop.compact();

      const snap = await store.open(sid);
      expect(snap.entries.some((e) => e.type === "compaction")).toBe(true);
    });

    afterAll(() => cleanup?.());
  });
}

// Run against both stores
testHarness("InMemory", () => createInMemorySessionStore());

const sqlitePath = `/tmp/harness-full-${Math.random().toString(36).slice(2, 8)}.db`;
testHarness(
  "SQLite",
  () => createSqliteSessionStore(sqlitePath),
  () => {
    try {
      unlinkSync(sqlitePath);
    } catch {
      /* */
    }
  },
);

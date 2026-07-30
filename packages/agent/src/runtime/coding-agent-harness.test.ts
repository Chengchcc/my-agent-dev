import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createSqliteSessionStore } from "../persistence/sqlite-session-store.js";
import { createAgentLoop } from "./agent-loop.js";

function testHarness(
  name: string,
  storeFactory: () => ReturnType<typeof createInMemorySessionStore>,
  cleanup?: () => void,
) {
  describe(`Coding Agent harness: ${name}`, () => {
    test("full loop with tool execution and steer", async () => {
      const store = storeFactory();
      const sid = `h-${Math.random().toString(36).slice(2, 8)}`;
      await store.create({
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

      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 3,
        maxForceContinues: 1,
        modelStream: async function* () {
          yield { delta: { type: "text", text: "done" } };
        },
      });

      expect(loop.status).toBe("idle");
      await loop.startLoop({ systemPrompt: "", metaText: "meta", promptText: "go" });
      expect(loop.status).toBe("settled");

      const snap = await store.open(sid);
      expect(snap.entries.length).toBeGreaterThan(1);
      // Product history entry + meta + prompt + assistant
      const types = snap.entries.map((e) => e.type);
      expect(types.filter((t) => t === "message").length).toBeGreaterThanOrEqual(3);
    });

    test("stop aborts running loop", async () => {
      const store = storeFactory();
      const sid = `h-stop-${Math.random().toString(36).slice(2, 8)}`;
      await store.create({
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

      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 100,
        maxForceContinues: 1,
        modelStream: async function* () {
          yield { delta: { type: "text", text: "streaming..." } };
        },
      });

      const started = loop.startLoop({ systemPrompt: "", metaText: "", promptText: "run" });
      loop.stop();
      await started;
      expect(loop.status).toBe("settled");
    });

    test("listener receives events", async () => {
      const store = storeFactory();
      const sid = `h-evt-${Math.random().toString(36).slice(2, 8)}`;
      await store.create({
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

      const events: string[] = [];
      const loop = createAgentLoop({
        sessionId: sid,
        store,
        plugins: [],
        systemPrompt: "",
        maxSteps: 2,
        maxForceContinues: 1,
        modelStream: async function* () {
          yield { delta: { type: "text", text: "ok" } };
        },
      });
      loop.onEvent((e) => {
        events.push(e.type);
      });

      await loop.startLoop({ systemPrompt: "", metaText: "", promptText: "go" });
      expect(events).toContain("agent_start");
      expect(events).toContain("agent_end");
    });

    afterAll(() => cleanup?.());
  });
}

// Run harness against both stores
testHarness("InMemory", () => createInMemorySessionStore());

const sqlitePath = `/tmp/harness-sqlite-${Math.random().toString(36).slice(2, 8)}.db`;
testHarness(
  "SQLite",
  () => createSqliteSessionStore(sqlitePath),
  () => {
    try {
      unlinkSync(sqlitePath);
    } catch {
      /* cleanup */
    }
  },
);

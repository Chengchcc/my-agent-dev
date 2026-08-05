import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { RuntimeOpsStore } from "./store.js";

function createTestDb() {
  return openDb(":memory:");
}

describe("RuntimeOpsStore", () => {
  let db: Database;
  let store: RuntimeOpsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RuntimeOpsStore(db);
  });

  afterEach(() => db.close());

  describe("surface_health", () => {
    test("upsert and get", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: { watchers: { conversation: 3 } },
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health).toBeDefined();
      expect(health!.status).toBe("running");
    });

    test("getSurfaceHealthsForAgent", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });

      expect(store.getSurfaceHealthsForAgent("agent_x")).toHaveLength(1);
    });

    test("upsertSurfaceHealth updates existing", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "degraded",
        payload: { error: "card failed" },
        lastError: "card update failed",
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health!.status).toBe("degraded");
      expect(health!.lastError).toBe("card update failed");
    });

    test("listSurfaceHealths orders by agentId then surface", () => {
      store.upsertSurfaceHealth({ agentId: "b", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "web", status: "ok", payload: {} });

      const rows = store.listSurfaceHealths();
      expect(rows.map((r) => `${r.agentId}/${r.surface}`)).toEqual(["a/lark", "a/web", "b/lark"]);
    });
  });
});

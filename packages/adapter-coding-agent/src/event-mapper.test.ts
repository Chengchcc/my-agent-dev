import { describe, expect, test } from "bun:test";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";

describe("event mapper", () => {
  test("message_update maps to text_delta", () => {
    const mapped = mapRunEvent({ id: 1, type: "message_update", data: { text: "hello" } });
    expect(mapped).toEqual({ type: "text_delta", text: "hello" });
  });

  test("tool events map to native tool core events", () => {
    const start = mapRunEvent({
      id: 2,
      type: "tool_execution_start",
      data: { toolName: "bash" },
    });
    expect(start).toEqual({ type: "native_tool_started", toolName: "bash", callId: "call-2" });
  });

  test("runtime lifecycle maps to namespaced extension", () => {
    const mapped = mapRunEvent({ id: 3, type: "compaction_start", data: {} });
    expect(mapped.type).toBe("backend.coding_agent.compaction_start");
  });

  test("agent_end maps to status", () => {
    const mapped = mapRunEvent({ id: 4, type: "agent_end", data: { status: "completed" } });
    expect(mapped).toEqual({ type: "status", status: "completed" });
  });

  test("all extension names start with backend.coding_agent.", () => {
    for (const type of ["retry_start", "message_start", "queue_update", "unknown_runtime"]) {
      const mapped = mapRunEvent({ id: 1, type, data: {} });
      if (mapped.type !== "status" && !("text" in mapped)) {
        expect(mapped.type.startsWith("backend.coding_agent.")).toBe(true);
      }
    }
  });

  test("completed outcome maps", () => {
    const mapped = mapRunOutcome({ status: "completed" });
    expect(mapped.status).toBe("completed");
  });

  test("failed/aborted/timeout map", () => {
    expect(mapRunOutcome({ status: "failed", error: "boom" }).status).toBe("failed");
    expect(mapRunOutcome({ status: "aborted" }).status).toBe("aborted");
    expect(mapRunOutcome({ status: "timeout" }).status).toBe("timeout");
  });

  test("suspended outcome rejected", () => {
    expect(() => mapRunOutcome({ status: "suspended" } as never)).toThrow(/suspended/);
  });
});

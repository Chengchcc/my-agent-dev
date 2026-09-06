import { describe, expect, test } from "bun:test";
import { AgentConfigEventBus } from "./agent-config-events.js";

describe("AgentConfigEventBus", () => {
  test("emits a changed event keyed by agent id", async () => {
    const bus = new AgentConfigEventBus();
    const seen: Array<{ trigger: string; agentId: string }> = [];
    const sub = bus.subscribe("agent-1");
    (async () => {
      for await (const ev of sub) {
        seen.push({ trigger: ev.data.trigger, agentId: ev.agentId });
        if (seen.length >= 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 0));
    bus.emit("agent-1", { trigger: "mcp", config: { name: "x" } });
    bus.emit("agent-1", { trigger: "save" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([
      { trigger: "mcp", agentId: "agent-1" },
      { trigger: "save", agentId: "agent-1" },
    ]);
    bus.dispose();
  });

  test("does not deliver events for other agent ids", async () => {
    const bus = new AgentConfigEventBus();
    const seen: string[] = [];
    const sub = bus.subscribe("agent-1");
    (async () => {
      for await (const ev of sub) {
        seen.push(ev.agentId);
        break;
      }
    })();
    await new Promise((r) => setTimeout(r, 0));
    bus.emit("agent-2", { trigger: "mcp" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]);
    bus.dispose();
  });
});

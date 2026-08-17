import { describe, expect, test } from "bun:test";
import { mapRunEvent } from "./mapping.js";

describe("workflow event mapping", () => {
  test("workflow lifecycle events map 1:1 to core events", () => {
    expect(
      mapRunEvent({
        id: 1,
        type: "workflow_started",
        data: { workflowId: "wf1", label: "audit", agentCount: 12 },
      }),
    ).toEqual({ type: "workflow_started", workflowId: "wf1", label: "audit", agentCount: 12 });
    expect(
      mapRunEvent({
        id: 2,
        type: "workflow_agent_started",
        data: { workflowId: "wf1", agentId: "a1", label: "src/a.ts" },
      }),
    ).toEqual({
      type: "workflow_agent_started",
      workflowId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
    });
    expect(
      mapRunEvent({
        id: 3,
        type: "workflow_agent_completed",
        data: { workflowId: "wf1", agentId: "a1", label: "src/a.ts", ok: true },
      }),
    ).toEqual({
      type: "workflow_agent_completed",
      workflowId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
      ok: true,
    });
    expect(
      mapRunEvent({
        id: 4,
        type: "workflow_completed",
        data: { workflowId: "wf1", ok: false, agentCount: 12, totalTokens: 500 },
      }),
    ).toEqual({
      type: "workflow_completed",
      workflowId: "wf1",
      ok: false,
      agentCount: 12,
      totalTokens: 500,
    });
  });

  test("an errored agent carries error + usage through", () => {
    const ev = mapRunEvent({
      id: 5,
      type: "workflow_agent_completed",
      data: {
        workflowId: "wf2",
        agentId: "a2",
        label: "x",
        ok: false,
        error: "boom",
        usage: { totalTokens: 10 },
      },
    });
    expect(ev).toEqual({
      type: "workflow_agent_completed",
      workflowId: "wf2",
      agentId: "a2",
      label: "x",
      ok: false,
      error: "boom",
      usage: { totalTokens: 10 },
    });
  });
});

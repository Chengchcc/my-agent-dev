import { describe, expect, test } from "bun:test";
import { executeRunInputSchema } from "./transport.js";

describe("executeRunInputSchema", () => {
  test("permissionMode and workflowBudgetTokens survive the wire", () => {
    const parsed = executeRunInputSchema.parse({
      input: { inputId: "in-1", message: { role: "user", text: "go" } },
      run: {
        runId: "run-1",
        model: { backendKind: "oma", modelId: "deepseek/deepseek-v4-flash" },
        configRevision: 1,
        permissionMode: "auto",
        workflowBudgetTokens: 12000,
      },
      workspace: { root: "/ws", access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b" },
    });
    expect(parsed.run.permissionMode).toBe("auto");
    expect(parsed.run.workflowBudgetTokens).toBe(12000);
  });
});

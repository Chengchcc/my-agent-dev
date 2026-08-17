import { describe, expect, test } from "bun:test";
import { agentWorkspaceSlug } from "./workspace.js";

describe("agentWorkspaceSlug", () => {
  test("slugs readable names", () => {
    expect(agentWorkspaceSlug("My Agent")).toBe("my-agent");
    expect(agentWorkspaceSlug("  DevOps  Bot  ")).toBe("devops-bot");
  });

  test("falls back for empty names", () => {
    expect(agentWorkspaceSlug("")).toBe("agent");
    expect(agentWorkspaceSlug("!!!")).toBe("agent");
  });
});

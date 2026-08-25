import { describe, expect, test } from "bun:test";
import {
  builtinAgentNames,
  isValidWorkflowName,
  parseAgentDefinition,
  resolveAgent,
} from "./subagent-registry.js";

describe("subagent-registry", () => {
  test("builtin explore/plan are read-only and task has all tools (claude trio)", async () => {
    const explore = await resolveAgent("explore", async () => null);
    expect(explore?.tools).toEqual(["read", "grep", "glob", "tree", "read_image"]);
    expect(explore?.systemPrompt).toContain("read-only");
    const plan = await resolveAgent("plan", async () => null);
    expect(plan?.tools).toEqual(["read", "grep", "glob", "tree", "read_image"]);
    expect(plan?.systemPrompt).toContain("plan");
    const task = await resolveAgent("task", async () => null);
    expect(task?.tools).toBeUndefined();
    expect(task?.systemPrompt).toContain("hyperfocus");
    expect(builtinAgentNames().sort()).toEqual(["explore", "plan", "task"]);
  });

  test("workspace definitions override builtins only by explicit name", async () => {
    const defs = new Map<string, string>([
      [
        "reviewer",
        "---\nname: reviewer\ndescription: Reviews\ntools: [read]\nmodel: fake/big\n---\nReview body",
      ],
    ]);
    const reviewer = await resolveAgent("reviewer", async (name) => defs.get(name) ?? null);
    expect(reviewer?.systemPrompt).toBe("Review body");
    expect(reviewer?.tools).toEqual(["read"]);
    expect(reviewer?.modelId).toBe("fake/big");
  });

  test("unknown and unsafe names resolve to null", async () => {
    expect(await resolveAgent("nope", async () => null)).toBeNull();
    expect(await resolveAgent("../evil", async () => "---\nname: x\n---\nbody")).toBeNull();
  });

  test("read_only workspaces skip workspace definitions (builtins only)", async () => {
    const defs = new Map<string, string>([["reviewer", "---\nname: reviewer\n---\nReview body"]]);
    const reviewer = await resolveAgent("reviewer", async (name) => defs.get(name) ?? null, {
      allowWorkspace: false,
    });
    expect(reviewer).toBeNull();
  });

  test("parseAgentDefinition requires a name", () => {
    expect(parseAgentDefinition("---\ntools: [read]\n---\nno name")).toBeNull();
    const ok = parseAgentDefinition("---\nname: x\ntools: [read, grep]\n---\nBody");
    expect(ok?.name).toBe("x");
    expect(ok?.tools).toEqual(["read", "grep"]);
  });

  test("isValidWorkflowName rejects path segments", () => {
    expect(isValidWorkflowName("explore")).toBe(true);
    expect(isValidWorkflowName("../x")).toBe(false);
    expect(isValidWorkflowName("a/b")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
  });
});

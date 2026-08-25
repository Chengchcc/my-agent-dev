import { describe, expect, test } from "bun:test";
import type { WorkflowAgentSpec } from "./workflow-executor.js";
import {
  createWorkflowTools,
  isValidWorkflowName,
  parseAgentDefinition,
} from "./workflow-tools.js";

const saved = new Map<string, string>();
const agentDefs = new Map<string, string>();
const subagentCalls: Array<{ spec: WorkflowAgentSpec; signal?: AbortSignal }> = [];
const deps = {
  runWorkflow: async () => ({ items: [], totalTokens: 0, ok: true }),
  runScript: async (input: { script: string }) => ({
    ok: true,
    totalTokens: 0,
    value: `ran:${input.script.slice(0, 8)}`,
  }),
  writeScript: (name: string, content: string) => {
    saved.set(name, content);
  },
  readScript: async (name: string) => saved.get(name) ?? null,
  runSubagent: async (spec: WorkflowAgentSpec, signal?: AbortSignal) => {
    subagentCalls.push({ spec, signal });
    return { label: spec.label ?? "sub", text: "ok", ok: true };
  },
  readAgentDefinition: async (name: string) => agentDefs.get(name) ?? null,
  listSubagents: () => [],
  getSubagentOutput: (handle: string) => ({ handle, status: "unknown" }),
  stopSubagent: (handle: string) => ({ ok: false, error: `unknown subagent handle "${handle}"` }),
};
const tools = createWorkflowTools(deps);
const runScriptTool = tools.find((t) => t.name === "workflow_run")!;
const runWorkflowTool = tools.find((t) => t.name === "run_workflow")!;
const subagentTool = tools.find((t) => t.name === "task")!;
const subagentListTool = tools.find((t) => t.name === "task_list")!;
const subagentOutputTool = tools.find((t) => t.name === "task_output")!;
const subagentStopTool = tools.find((t) => t.name === "task_stop")!;

describe("workflow_run", () => {
  test("saves a script and re-runs it by name only (B8)", async () => {
    const first = (await runScriptTool.execute({ script: "const a = 1;", name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
    };
    expect(first.scriptSaved).toBe(true);
    expect(saved.get("audit")).toBe("const a = 1;");

    const second = (await runScriptTool.execute({ name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
      value?: unknown;
    };
    expect(second.scriptSaved).toBe(false);
    expect(second.ok).toBe(true);
    expect(String(second.value)).toContain("ran:const a");
  });

  test("rejects an unknown saved name", async () => {
    const out = (await runScriptTool.execute({ name: "missing" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not found");
  });

  test("rejects path-escape names", async () => {
    const out = (await runScriptTool.execute({ name: "../evil" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("invalid workflow name");
  });

  test("requires script or name", async () => {
    const out = (await runScriptTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("script or name");
  });
});

describe("subagent", () => {
  test("dispatches builtin explore with read-only tools (3.4)", async () => {
    subagentCalls.length = 0;
    const out = (await subagentTool.execute({ agent: "explore", prompt: "look around" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toContain("read-only");
    expect(call.spec.toolNames).toEqual(["read", "grep", "glob", "tree", "read_image"]);
  });

  test("loads .oma/agents/<name>.md definitions (3.4)", async () => {
    subagentCalls.length = 0;
    agentDefs.set(
      "reviewer",
      "---\nname: reviewer\ntools: [read, grep]\nmodel: fake/big\n---\nYou review code carefully.",
    );
    const out = (await subagentTool.execute({ agent: "reviewer", prompt: "review" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toBe("You review code carefully.");
    expect(call.spec.toolNames).toEqual(["read", "grep"]);
    expect(call.spec.modelId).toBe("fake/big");
    expect(call.spec.label).toBe("reviewer");
  });

  test("rejects unknown agents with a clear error and the builtin list", async () => {
    const out = (await subagentTool.execute({ agent: "nope", prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unknown subagent");
    expect(out.error).toContain("explore, plan, task");
  });

  test("requires prompt (and agent or resume)", async () => {
    const noPrompt = (await subagentTool.execute({ agent: "explore" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noPrompt.ok).toBe(false);
    expect(noPrompt.error).toContain("prompt is required");
    const noAgent = (await subagentTool.execute({ prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noAgent.ok).toBe(false);
    expect(noAgent.error).toContain("agent (or resume handle)");
  });

  test("surfaces the handle and resumes with it (3.4 Phase 2)", async () => {
    subagentCalls.length = 0;
    const handle = "sub-abc123";
    const originalRunSubagent = deps.runSubagent;
    deps.runSubagent = async (spec, signal) => {
      subagentCalls.push({ spec, signal });
      return {
        label: spec.label ?? "sub",
        text: spec.resumeHandle ? "follow-up done" : "first done",
        ok: true,
        handle,
      };
    };
    try {
      const first = (await subagentTool.execute({ agent: "explore", prompt: "first" })) as {
        handle?: string;
      };
      expect(first.handle).toBe(handle);
      const resumed = (await subagentTool.execute({ resume: handle, prompt: "more" })) as {
        ok?: boolean;
        text?: string;
      };
      expect(resumed.ok).toBe(true);
      expect(resumed.text).toBe("follow-up done");
      expect(subagentCalls[1]?.spec.resumeHandle).toBe(handle);
    } finally {
      deps.runSubagent = originalRunSubagent;
    }
  });
});

describe("parseAgentDefinition", () => {
  test("parses the four frontmatter fields and body", () => {
    const def = parseAgentDefinition(
      "---\nname: reviewer\ndescription: Reviews diffs\ntools: [read, grep]\nmodel: fake/big\n---\nBody prompt",
    );
    expect(def?.systemPrompt).toBe("Body prompt");
    expect(def?.tools).toEqual(["read", "grep"]);
    expect(def?.modelId).toBe("fake/big");
    expect(def?.description).toBe("Reviews diffs");
  });

  test("returns null without a name or frontmatter", () => {
    expect(parseAgentDefinition("Just a prompt.")).toBeNull();
    expect(parseAgentDefinition("---\ntools: [read]\n---\nNo name")).toBeNull();
  });
});

describe("subagent control plane", () => {
  test("subagent_output and subagent_stop delegate to the deps", async () => {
    const out = (await subagentOutputTool.execute({ handle: "sub-x" })) as {
      status?: string;
    };
    expect(out.status).toBe("unknown");
    const stopped = (await subagentStopTool.execute({ handle: "sub-x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toContain("unknown subagent handle");
  });

  test("subagent_list returns the dep list", async () => {
    const out = (await subagentListTool.execute({})) as { tasks?: unknown[] };
    expect(out.tasks).toEqual([]);
  });

  test("requires a handle for output/stop", async () => {
    const out = (await subagentOutputTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("handle is required");
  });
});

describe("workflow tool names", () => {
  test("isValidWorkflowName rejects path segments", () => {
    expect(isValidWorkflowName("audit")).toBe(true);
    expect(isValidWorkflowName("../audit")).toBe(false);
    expect(isValidWorkflowName("a/b")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
  });

  test("all six tools are registered (task = claude Task parity)", () => {
    expect(runWorkflowTool.name).toBe("run_workflow");
    expect(runScriptTool.name).toBe("workflow_run");
    expect(subagentTool.name).toBe("task");
    expect(subagentListTool.name).toBe("task_list");
    expect(subagentOutputTool.name).toBe("task_output");
    expect(subagentStopTool.name).toBe("task_stop");
  });
});

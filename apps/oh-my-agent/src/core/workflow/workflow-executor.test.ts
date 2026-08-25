import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "@chengchenccc/ai";
import type { AIMessageChunk } from "@chengchenccc/core";
import { createEchoModelStream } from "../__fixtures__/echo-model.js";
import type { PluginTool } from "../agent-runtime.js";
import { createWorkflowExecutor } from "./workflow-executor.js";

const events: Array<{ type: string }> = [];
const emit = (e: unknown): void => {
  events.push(e as { type: string });
};

// Title generation performs an extra model call on completed runs; these
// tests count model calls and must be deterministic.
process.env.OMA_TITLE_ENABLED = "0";

function makeDeps() {
  return {
    makeSubagentStream: (sessionId: string) => createEchoModelStream(`echo:${sessionId}`),
    modelId: "fake/echo",
    summarize: async () => "[summary]",
    contextBudget: { estimate: () => 0, limit: 100_000, triggerRatio: 0.7 },
    tools: [],
    workspaceRoot: "/tmp/wf-test",
    workspaceAccess: "read_only" as const,
    maxConcurrent: 2,
    maxTotal: 4,
    emit,
  };
}

describe("createWorkflowExecutor", () => {
  afterEach(() => {
    events.length = 0;
  });

  test("runWorkflow fans out and aggregates with lifecycle events", async () => {
    const exec = createWorkflowExecutor(makeDeps());
    const result = await exec.runWorkflow({
      workflowId: "wf1",
      label: "audit",
      items: [
        { prompt: "one", label: "a" },
        { prompt: "two", label: "b" },
        { prompt: "three", label: "c" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.text)).toEqual([
      "echo:wf:wf1:a0",
      "echo:wf:wf1:a1",
      "echo:wf:wf1:a2",
    ]);
    expect(events.filter((e) => e.type === "workflow_agent_started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "workflow_agent_completed")).toHaveLength(3);
    const started = events.find((e) => e.type === "workflow_started") as {
      agentCount: number;
    };
    expect(started.agentCount).toBe(3);
    const done = events.find((e) => e.type === "workflow_completed") as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  test("the total cap rejects excess agents with a clear error", async () => {
    const exec = createWorkflowExecutor(makeDeps());
    await expect(
      exec.runWorkflow({
        workflowId: "wf2",
        label: "big",
        items: Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/4-agent cap/);
  });

  test("a budget gate can refuse new spawns", async () => {
    let budget = 2;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      budgetGate: () =>
        --budget >= 0 ? { allowed: true } : { allowed: false, reason: "budget exhausted" },
    });
    await expect(
      exec.runWorkflow({
        workflowId: "wf3",
        label: "gated",
        items: [1, 2, 3].map((i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/budget exhausted/);
  });

  test("schema output is parsed from the final JSON text", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream('{"ok":true}'),
    });
    const result = await exec.runSubagent({
      workflowId: "wf4",
      agentId: "a1",
      prompt: "return json",
      label: "x",
      schema: { type: "object" },
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.ok).toBe(true);
  });

  test("malformed schema output marks the agent failed with the error", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream("not json at all"),
    });
    const result = await exec.runSubagent({
      workflowId: "wf5",
      agentId: "a1",
      prompt: "return json",
      schema: { type: "object" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });
  test("a rejected spawn releases its concurrency slot (no deadlock)", async () => {
    let allow = false;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      maxConcurrent: 1,
      budgetGate: () =>
        allow ? { allowed: true } : { allowed: false, reason: "budget exhausted" },
    });
    await expect(
      exec.runWorkflow({ workflowId: "wf6", label: "denied", items: [{ prompt: "p1" }] }),
    ).rejects.toThrow(/budget exhausted/);
    // The rejected spawn released its slot; a later allowed run completes
    // instead of deadlocking on the leaked acquire.
    allow = true;
    const result = await exec.runWorkflow({
      workflowId: "wf7",
      label: "ok",
      items: [{ prompt: "p2" }],
    });
    expect(result.ok).toBe(true);
  });

  test("a gate failure aborts in-flight siblings and emits workflow_failed", async () => {
    const blocked: string[] = [];
    let spawns = 0;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      maxConcurrent: 2,
      budgetGate: () =>
        ++spawns <= 2 ? { allowed: true } : { allowed: false, reason: "budget exhausted" },
      makeSubagentStream: (sessionId) => {
        if (sessionId.endsWith(":a0")) {
          blocked.push(sessionId);
          return async function* (_messages: unknown, signal?: AbortSignal) {
            yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          };
        }
        return createEchoModelStream(`echo:${sessionId}`);
      },
    });
    await expect(
      exec.runWorkflow({
        workflowId: "wf-gate",
        label: "gated",
        items: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
      }),
    ).rejects.toThrow(/budget exhausted/);
    // a0 was still in flight when the third spawn tripped the gate; the
    // workflow aborted it instead of orphaning it (B1).
    expect(blocked).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "workflow_failed",
        error: expect.stringContaining("budget exhausted"),
      }),
    );
  });

  test("a queued agent aborts while waiting for a slot", async () => {
    const started: string[] = [];
    let a0Started!: () => void;
    const a0Gate = new Promise<void>((resolve) => {
      a0Started = resolve;
    });
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      maxConcurrent: 1,
      makeSubagentStream: (sessionId) => {
        if (sessionId.endsWith(":a0")) {
          return async function* (_messages: unknown, signal?: AbortSignal) {
            yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
              // Signal readiness only AFTER the abort listener is registered,
              // so the abort below is guaranteed to be observed.
              a0Started();
            });
          };
        }
        started.push(sessionId);
        return async function* (_messages: unknown, signal?: AbortSignal) {
          yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        };
      },
    });
    const controller = new AbortController();
    const p = exec.runWorkflow({
      workflowId: "wf-queue",
      label: "queue",
      items: [{ prompt: "a" }, { prompt: "b" }],
      signal: controller.signal,
    });
    // a0's stream began; a1 is queued behind the single slot.
    await a0Gate;
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(started).toHaveLength(1); // the queued agent never spawned (B2)
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow_failed" }));
  });

  test("a transient subagent model failure retries (B5, default policy)", async () => {
    let calls = 0;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* () {
          calls++;
          if (calls === 1) throw new ProviderError("transient boom", "transient");
          yield { delta: { type: "text", text: "recovered" } };
          yield { stopReason: "end_turn" };
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-retry",
      agentId: "a1",
      prompt: "go",
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("recovered");
  });

  test("a failed subagent loop surfaces its error text (B5)", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* () {
          yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
          throw new ProviderError("persistent boom", "transient");
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-err",
      agentId: "a1",
      prompt: "go",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("persistent boom"); // error not dropped
  });

  test("schema violations trigger one correction retry (A2)", async () => {
    let calls = 0;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* () {
          calls++;
          yield {
            delta: { type: "text", text: calls === 1 ? '{"nope":1}' : '{"ok":true}' },
          };
          yield { stopReason: "end_turn" };
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-schema-fix",
      agentId: "a1",
      prompt: "return ok json",
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: true });
  });

  test("a second schema violation is terminal with the error (A2)", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* () {
          yield { delta: { type: "text", text: '{"nope":1}' } };
          yield { stopReason: "end_turn" };
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-schema-fail",
      agentId: "a1",
      prompt: "return ok json",
      schema: { type: "object", required: ["ok"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing required property");
  });

  test("long item texts spill to .oma/workflow with a resultPath (A3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-spill-"));
    const longText = "x".repeat(3000);
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      workspaceRoot: dir,
      workspaceAccess: "read_write",
      makeSubagentStream: () => createEchoModelStream(longText),
    });
    try {
      const result = await exec.runWorkflow({
        workflowId: "wf-spill",
        label: "big",
        items: [{ prompt: "long" }],
      });
      const item = result.items[0]!;
      expect(item.resultPath).toBe(".oma/workflow/wf-spill/a0.result.md");
      expect(item.text.length).toBe(400);
      expect(readFileSync(join(dir, item.resultPath), "utf8")).toBe(longText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read_only workspaces truncate long texts instead of spilling (A3)", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream("y".repeat(3000)),
    });
    const result = await exec.runWorkflow({
      workflowId: "wf-ro",
      label: "ro",
      items: [{ prompt: "long" }],
    });
    const item = result.items[0]!;
    expect(item.resultPath).toBeUndefined();
    expect(item.text).toContain("[truncated]");
    expect(item.text.length).toBeLessThan(500);
  });

  test("the total inline budget forces spill even under the per-item ceiling (A3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-fuse-"));
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      workspaceRoot: dir,
      workspaceAccess: "read_write",
      maxTotal: 9,
      makeSubagentStream: () => createEchoModelStream("z".repeat(1900)),
    });
    try {
      const result = await exec.runWorkflow({
        workflowId: "wf-fuse",
        label: "many",
        items: Array.from({ length: 9 }, (_, i) => ({ prompt: `p${i}` })),
      });
      expect(result.items).toHaveLength(9);
      for (const [i, item] of result.items.entries()) {
        expect(item.resultPath).toBe(`.oma/workflow/wf-fuse/a${i}.result.md`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("subagent state dumps spec + transcript to .session.json (A1/F2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-state-"));
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      workspaceRoot: dir,
      workspaceAccess: "read_write",
    });
    try {
      const result = await exec.runSubagent({
        workflowId: "wf-state",
        agentId: "a1",
        prompt: "go",
        systemPrompt: "ROLE BODY",
        toolNames: ["read"],
      });
      expect(result.ok).toBe(true);
      const state = JSON.parse(
        readFileSync(join(dir, ".oma/workflow/wf-state/a1.session.json"), "utf8"),
      ) as {
        agentId?: string;
        messages?: unknown[];
        spec?: { prompt?: string; systemPrompt?: string; toolNames?: string[] };
      };
      expect(state.agentId).toBe("a1");
      expect(Array.isArray(state.messages)).toBe(true);
      expect(state.spec?.prompt).toBe("go");
      expect(state.spec?.systemPrompt).toBe("ROLE BODY");
      expect(state.spec?.toolNames).toEqual(["read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("artifacts list the files the subagent wrote (A4)", async () => {
    let calls = 0;
    const writeTool: PluginTool = {
      name: "write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async execute() {
        return { ok: true };
      },
    };
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      tools: [writeTool],
      makeSubagentStream: () =>
        async function* () {
          calls++;
          if (calls === 1) {
            yield { delta: { type: "tool_use", id: "tc1", name: "write" } };
            yield {
              delta: { type: "input_json_delta", id: "tc1", partial_json: '{"path":"a.txt"}' },
            };
            yield { stopReason: "tool_use" };
            return;
          }
          yield { delta: { type: "text", text: "done" } };
          yield { stopReason: "end_turn" };
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-art",
      agentId: "a1",
      prompt: "write a file",
    });
    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual(["a.txt"]);
  });

  test("runSubagent honors spec systemPrompt and tool allowlist (3.4)", async () => {
    const seenSystem: string[] = [];
    const readTool: PluginTool = {
      name: "read",
      description: "Read a file",
      async execute() {
        return { ok: true };
      },
    };
    const writeTool: PluginTool = {
      name: "write",
      description: "Write a file",
      async execute() {
        return { ok: true };
      },
    };
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      tools: [readTool, writeTool],
      makeSubagentStream: () =>
        async function* (messages: readonly { role?: string; text?: string }[]) {
          seenSystem.push(messages.find((m) => m.role === "system")?.text ?? "");
          yield { delta: { type: "text", text: "done" } };
          yield { stopReason: "end_turn" };
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-role",
      agentId: "a1",
      prompt: "go",
      systemPrompt: "ROLE PROMPT",
      toolNames: ["read"],
    });
    expect(result.ok).toBe(true);
    expect(seenSystem[0]).toContain("ROLE PROMPT");
  });

  test("role modelId override reaches the subagent stream (3.4)", async () => {
    const seenModelIds: Array<string | undefined> = [];
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: (_sessionId, modelId) => {
        seenModelIds.push(modelId);
        return createEchoModelStream("ok");
      },
    });
    await exec.runSubagent({
      workflowId: "wf-model",
      agentId: "a1",
      prompt: "go",
      modelId: "fake/big",
    });
    expect(seenModelIds).toEqual(["fake/big"]);
  });

  test("resume continues the same session with its pinned spec (3.4 Phase 2)", async () => {
    const seenSystems: string[] = [];
    let calls = 0;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* (messages: readonly { role?: string; text?: string }[]) {
          calls++;
          seenSystems.push(messages.find((m) => m.role === "system")?.text ?? "");
          if (calls === 1) {
            yield { delta: { type: "text", text: "first" } };
            yield { stopReason: "end_turn" };
            return;
          }
          // Resume round: the prior turn's message is in the session history.
          expect(messages.some((m) => m.text === "first")).toBe(true);
          yield { delta: { type: "text", text: "second" } };
          yield { stopReason: "end_turn" };
        },
    });
    const first = await exec.runSubagent({
      workflowId: "wf-resume",
      agentId: "a1",
      prompt: "first task",
      systemPrompt: "PINNED ROLE",
    });
    expect(first.handle).toBeTruthy();
    const resumed = await exec.runSubagent({
      workflowId: "ignored",
      agentId: "ignored",
      prompt: "follow up",
      systemPrompt: "MUTATED ROLE", // registry edit between calls must NOT leak in
      resumeHandle: first.handle,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.text).toBe("second");
    expect(resumed.handle).toBeUndefined(); // follow-ups reuse the same handle
    expect(seenSystems[1]).toContain("PINNED ROLE");
    expect(seenSystems[1]).not.toContain("MUTATED ROLE");
  });

  test("resume with an unknown handle errors with the active list", async () => {
    const exec = createWorkflowExecutor(makeDeps());
    const result = await exec.runSubagent({
      workflowId: "wf-x",
      agentId: "a1",
      prompt: "go",
      resumeHandle: "sub-missing",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown subagent handle");
  });

  test("background dispatch returns immediately; stop lands a stopped result (3.4 Phase 3)", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* (_messages: unknown, signal?: AbortSignal) {
          yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
    });
    const started = await exec.runSubagent({
      workflowId: "wf-bg",
      agentId: "a1",
      prompt: "go",
      background: true,
    });
    expect(started.status).toBe("running");
    expect(started.handle).toBeTruthy();
    expect(exec.listSubagents()[0]?.status).toBe("running");

    exec.stopSubagent(started.handle!);
    const deadline = Date.now() + 2000;
    let out = exec.getSubagentOutput(started.handle!);
    while (out.status === "running" && Date.now() < deadline) {
      await Bun.sleep(10);
      out = exec.getSubagentOutput(started.handle!);
    }
    expect(out.status).toBe("stopped");
    expect(out.result?.ok).toBe(false);
    expect(out.result?.error).toBe("stopped");
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow_agent_completed" }));
  });

  test("subagent_output transitions running to completed with the result", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream("bg result"),
    });
    const started = await exec.runSubagent({
      workflowId: "wf-bg2",
      agentId: "a1",
      prompt: "go",
      background: true,
    });
    const deadline = Date.now() + 2000;
    let out = exec.getSubagentOutput(started.handle!);
    while (out.status === "running" && Date.now() < deadline) {
      await Bun.sleep(10);
      out = exec.getSubagentOutput(started.handle!);
    }
    expect(out.status).toBe("completed");
    expect(out.result?.ok).toBe(true);
    expect(out.result?.text).toBe("bg result");
  });

  test("abortAllSubagents stops every background subagent (run teardown)", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () =>
        async function* (_messages: unknown, signal?: AbortSignal) {
          yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
    });
    const a = await exec.runSubagent({
      workflowId: "wf-c1",
      agentId: "a1",
      prompt: "x",
      background: true,
    });
    const b = await exec.runSubagent({
      workflowId: "wf-c2",
      agentId: "a2",
      prompt: "y",
      background: true,
    });
    exec.abortAllSubagents();
    const deadline = Date.now() + 2000;
    while (
      exec.getSubagentOutput(a.handle!).status === "running" &&
      exec.getSubagentOutput(b.handle!).status === "running" &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    expect(exec.getSubagentOutput(a.handle!).status).toBe("stopped");
    expect(exec.getSubagentOutput(b.handle!).status).toBe("stopped");
  });

  test("a budget gate refuses background spawns too", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      budgetGate: () => ({ allowed: false, reason: "budget exhausted" }),
    });
    await expect(
      exec.runSubagent({ workflowId: "wf-bg3", agentId: "a1", prompt: "go", background: true }),
    ).rejects.toThrow(/budget exhausted/);
  });

  test("spec schema is passed as responseFormat to the subagent stream (F5)", async () => {
    const seen: Array<{ modelId?: string; responseFormat?: unknown }> = [];
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: (_sessionId, modelId, responseFormat) => {
        seen.push({ modelId, responseFormat });
        return createEchoModelStream("ok");
      },
    });
    await exec.runSubagent({
      workflowId: "wf-f5",
      agentId: "a1",
      prompt: "go",
      schema: { type: "object" },
    });
    expect(seen[0]?.responseFormat).toEqual({
      name: "result",
      schema: { type: "object" },
      strict: true,
    });
  });

  test("perAgentTimeoutMs stops a subagent that exceeds its deadline", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      perAgentTimeoutMs: 20,
      makeSubagentStream: () =>
        async function* (_messages: unknown, signal?: AbortSignal) {
          yield { delta: { type: "text", text: "partial" } } as AIMessageChunk;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
    });
    const result = await exec.runSubagent({
      workflowId: "wf-timeout",
      agentId: "a1",
      prompt: "slow",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy(); // deadline reason surfaced (B7)
  });
});

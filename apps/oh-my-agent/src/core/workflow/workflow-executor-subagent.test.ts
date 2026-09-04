import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createEchoModelStream } from "../__fixtures__/echo-model.js";
import type { PluginTool } from "../agent-runtime.js";
import { createWorkflowExecutor, createWorkflowFixture } from "./workflow-executor.fixture.js";

const { events, makeDeps } = createWorkflowFixture();

describe("createWorkflowExecutor", () => {
  afterEach(() => {
    events.length = 0;
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

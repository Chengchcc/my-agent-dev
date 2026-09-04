import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessageChunk } from "@chengchenccc/message";
import { createEchoModelStream } from "../__fixtures__/echo-model.js";
import {
  createWorkflowExecutor,
  createWorkflowFixture,
  ProviderError,
} from "./workflow-executor.fixture.js";

const { events, makeDeps } = createWorkflowFixture();

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
});

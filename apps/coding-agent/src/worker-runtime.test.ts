import { describe, expect, test } from "bun:test";
import {
  type CodingAgentSession,
  createInMemorySessionStore,
  type SessionStore,
} from "@my-agent-team/agent";
import type { WorkerRuntime } from "./worker-runtime.js";

function makeRuntime(sessionId: string): WorkerRuntime & { store: SessionStore } {
  const store = createInMemorySessionStore();
  const session: CodingAgentSession = {
    sessionId,
    status: "idle",
    async startLoop() {
      session.status = "completed";
      return { status: "completed", output: { role: "assistant", text: "done" } };
    },
    async startFollowUp() {
      session.status = "completed";
      return { status: "completed", output: { role: "assistant", text: "done" } };
    },
    steer() {},
    stop() {
      session.status = "stopped";
    },
    async compact() {},
    onEvent() {
      return () => {};
    },
  };
  return {
    sessionId,
    store,
    session,
    summarize: async () => "sum",
    contextBudget: undefined,
    setActiveRun() {},
    async close() {
      await store.close();
    },
  } as unknown as WorkerRuntime & { store: SessionStore };
}

describe("worker runtime assembly", () => {
  test("assembleWorkerRuntime wires one session", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const dataDir = `/tmp/coding-agent-test-${Math.random().toString(36).slice(2, 8)}`;
    const ws = `${dataDir}/ws`;
    mkdirSync(ws, { recursive: true });
    const { assembleWorkerRuntime } = await import("./worker-runtime.js");
    const { createModelRuntime } = await import("@my-agent-team/ai");
    const runtime = await assembleWorkerRuntime({
      dataDir,
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      backendSessionId: "sess-1",
      modelRuntime: createModelRuntime(),
      skillRoots: [],
    });
    expect(runtime.sessionId).toBe("sess-1");
    // Empty model catalog => no budget (proactive compaction disabled)
    expect(runtime.contextBudget).toBeUndefined();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("worker main dispatch", () => {
  test("start_run dispatches normal loop and emits exactly one outcome", async () => {
    const _events: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const sentLines: string[] = [];
    const { runWorkerMain } = await import("./worker-main.js");
    const { Readable, Writable } = await import("node:stream");

    const input = new Readable({
      read() {
        this.push(
          `${JSON.stringify({
            protocolVersion: 1,
            type: "open_session",
            commandId: "c1",
            backendSessionId: "sess-1",
            dataDir: "/tmp/d",
            workspaceRoot: "/tmp/ws",
            workspaceAccess: "read_write" as const,
            backendKind: "coding_agent",
            createIfMissing: true,
            identity: { conversationId: "c", agentMemberId: "m" },
          })}\n`,
        );
        this.push(
          `${JSON.stringify({
            protocolVersion: 1,
            type: "start_run",
            commandId: "c2",
            backendSessionId: "sess-1",
            runId: "run-1",
            mode: "normal",
            history: [],
            run: {
              runId: "run-1",
              model: { backendKind: "coding_agent", modelId: "m" },
              productTools: [],
              configRevision: 1,
            },
            input: { inputId: "in-1", message: { role: "user", text: "go" } },
            workspace: { root: "/tmp/ws", access: "read_write" },
            metadata: {
              conversationId: "c",
              agentMemberId: "m",
              branchId: "b",
              productRevision: 1,
            },
          })}\n`,
        );
        this.push(null);
      },
    });
    const output = new Writable({
      write(chunk: Buffer, _enc, cb) {
        sentLines.push(chunk.toString());
        cb();
      },
    });

    const result = await runWorkerMain({
      stdin: input as never,
      stdout: output as never,
      stderr: process.stderr,
      runtimeFactory: ({ backendSessionId }) => makeRuntime(backendSessionId),
    });

    const parsed = sentLines.map((l) => JSON.parse(l.trim()));
    const accepted = parsed.filter((p) => p.type === "command_accepted");
    const outcomes = parsed.filter((p) => p.type === "outcome");
    expect(accepted).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
    expect(result).toBe(0);
    expect(outcomes[0]?.outcome).toMatchObject({ status: "completed" });
    void sent;
  });
});

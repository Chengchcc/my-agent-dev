import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendRunInput,
  BackendRunSegment,
  ProjectedHistoryItem,
} from "@my-agent-team/agent-backend";
import { OmpBackend, OmpBackendError } from "./backend.js";

const FAKE_ENTRY = join(import.meta.dir, "__fixtures__", "fake-omp.ts");

function makeBackend(fixture: string): OmpBackend {
  return new OmpBackend({
    executable: process.execPath,
    args: [FAKE_ENTRY],
    env: { OMP_FAKE_FIXTURE: fixture },
  });
}

function makeInput(branchId = "b1", history: ProjectedHistoryItem[] = []): BackendRunInput<"omp"> {
  return {
    history,
    input: { inputId: "i1", message: { role: "user", text: "hello" } },
    run: {
      runId: "run-1",
      model: { backendKind: "omp", modelId: "deepseek/deepseek-v4-flash" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: "/tmp", access: "read_write" },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId },
  };
}

async function drain(
  segment: BackendRunSegment<"omp">,
): Promise<{ events: string[]; outcome: Awaited<ReturnType<(typeof segment.outcome)["then"]>> }> {
  const events: string[] = [];
  for await (const ev of segment.events) events.push(ev.type);
  const outcome = await segment.outcome;
  return { events, outcome };
}

describe("OmpBackend", () => {
  test("text fixture completes with events + final message", async () => {
    const backend = makeBackend("omp-wire-text.jsonl");
    const segment = await backend.execute(makeInput());
    const { events, outcome } = await drain(segment);
    expect(events).toContain("text_delta");
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.messages?.at(-1)).toEqual({ role: "assistant", text: "OK" });
      expect(outcome.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  test("tool fixture completes with native tool events", async () => {
    const backend = makeBackend("omp-wire-tool.jsonl");
    const segment = await backend.execute(makeInput());
    const { events, outcome } = await drain(segment);
    expect(events.filter((t) => t === "native_tool_started").length).toBeGreaterThanOrEqual(1);
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.messages?.at(-1)?.text).toContain("hello");
    }
  });

  test("steer is explicitly rejected (per-turn process)", async () => {
    const backend = makeBackend("omp-wire-text.jsonl");
    await expect(
      backend.steer("run-1", { inputId: "s1", message: { role: "user", text: "steer" } }),
    ).rejects.toThrow(OmpBackendError);
  });

  test("stop aborts a live run", async () => {
    // A fixture that sleeps before printing lets stop() win the race.
    const backend = new OmpBackend({
      executable: process.execPath,
      args: [join(import.meta.dir, "__fixtures__", "slow-omp.ts")],
      abortGraceMs: 500,
    });
    const segment = await backend.execute(makeInput());
    await segment.stop();
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("aborted");
  });

  test("session file is pinned per branch and resumed", async () => {
    const ws = mkdtempSync(join(tmpdir(), "omp-adapter-"));
    const backend = makeBackend("omp-wire-text.jsonl");
    const input = makeInput("branch-x");
    const withWs = { ...input, workspace: { root: ws, access: "read_write" as const } };
    const sessionFile = join(ws, ".my-agent", "omp-session", "branch-x.jsonl");
    await drain(await backend.execute(withWs));
    // First run wrote the branch-pinned session file via `--session`.
    expect(await Bun.file(sessionFile).exists()).toBe(true);
    const firstArgs = JSON.parse(await Bun.file(`${sessionFile}.args`).text()) as string[];
    expect(firstArgs).toContain("--session");
    expect(firstArgs.some((a) => a.includes("branch-x.jsonl"))).toBe(true);
    // Second run on the same branch resumes via `-r`.
    await drain(await backend.execute(withWs));
    const secondArgs = JSON.parse(await Bun.file(`${sessionFile}.args`).text()) as string[];
    expect(secondArgs).toContain("-r");
    rmSync(ws, { recursive: true, force: true });
  });
});

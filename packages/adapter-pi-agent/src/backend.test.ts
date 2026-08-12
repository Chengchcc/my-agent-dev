import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput, BackendRunSegment } from "@my-agent-team/agent-backend";
import { PiBackend, PiBackendError } from "./backend.js";

const FAKE_ENTRY = join(import.meta.dir, "__fixtures__", "fake-pi.ts");

function makeBackend(fixture: string): PiBackend {
  return new PiBackend({
    executable: process.execPath,
    args: [FAKE_ENTRY],
    env: { PI_FAKE_FIXTURE: fixture },
  });
}

function makeInput(branchId = "b1"): BackendRunInput<"pi"> {
  return {
    history: [],
    input: { inputId: "i1", message: { role: "user", text: "hello" } },
    run: {
      runId: "run-1",
      model: { backendKind: "pi", modelId: "deepseek/deepseek-v4-flash" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: "/tmp", access: "read_write" },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId },
  };
}

async function drain(
  segment: BackendRunSegment<"pi">,
): Promise<{ events: string[]; outcome: Awaited<ReturnType<(typeof segment.outcome)["then"]>> }> {
  const events: string[] = [];
  for await (const ev of segment.events) events.push(ev.type);
  return { events, outcome: await segment.outcome };
}

describe("PiBackend", () => {
  test("text fixture completes with events + final message", async () => {
    const backend = makeBackend("pi-wire-text.jsonl");
    const { events, outcome } = await drain(await backend.execute(makeInput()));
    expect(events).toContain("text_delta");
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.messages?.at(-1)).toEqual({ role: "assistant", text: "OK" });
      expect(outcome.usage?.inputTokens).toBe(3618);
    }
  });

  test("tool fixture completes with native tool events", async () => {
    const backend = makeBackend("pi-wire-tool.jsonl");
    const { events, outcome } = await drain(await backend.execute(makeInput()));
    expect(events.filter((t) => t === "native_tool_started")).toHaveLength(1);
    expect(outcome.status).toBe("completed");
  });

  test("steer is explicitly rejected (per-turn process)", async () => {
    const backend = makeBackend("pi-wire-text.jsonl");
    await expect(
      backend.steer("run-1", { inputId: "s1", message: { role: "user", text: "steer" } }),
    ).rejects.toThrow(PiBackendError);
  });

  test("session file pinned per branch; --session used on both runs", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-adapter-"));
    const backend = makeBackend("pi-wire-text.jsonl");
    const input = makeInput("branch-x");
    const withWs = { ...input, workspace: { root: ws, access: "read_write" as const } };
    const sessionFile = join(ws, ".my-agent", "pi-session", "branch-x.jsonl");
    await drain(await backend.execute(withWs));
    expect(await Bun.file(sessionFile).exists()).toBe(true);
    const firstArgs = JSON.parse(await Bun.file(`${sessionFile}.args`).text()) as string[];
    expect(firstArgs).toContain("--session");
    // pi resumes an existing session file through the SAME --session flag.
    await drain(await backend.execute(withWs));
    const secondArgs = JSON.parse(await Bun.file(`${sessionFile}.args`).text()) as string[];
    expect(secondArgs).toContain("--session");
    expect(secondArgs).not.toContain("-r");
    // provider/model split into pi's two flags
    expect(secondArgs).toContain("--provider");
    expect(secondArgs).toContain("deepseek");
    rmSync(ws, { recursive: true, force: true });
  });
});

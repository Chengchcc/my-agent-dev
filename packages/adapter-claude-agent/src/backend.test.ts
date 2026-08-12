import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput, BackendRunSegment } from "@my-agent-team/agent-backend";
import { ClaudeBackend, ClaudeBackendError } from "./backend.js";

const FAKE_ENTRY = join(import.meta.dir, "__fixtures__", "fake-claude.ts");

function makeBackend(fixture: string, logPath: string): ClaudeBackend {
  return new ClaudeBackend({
    executable: process.execPath,
    args: [FAKE_ENTRY],
    env: { CLAUDE_FAKE_FIXTURE: fixture, CLAUDE_FAKE_LOG: logPath },
  });
}

function makeInput(branchId = "b1"): BackendRunInput<"claude_code"> {
  return {
    history: [],
    input: { inputId: "i1", message: { role: "user", text: "hello" } },
    run: {
      runId: "run-1",
      model: { backendKind: "claude_code", modelId: "deepseek/deepseek-v4-pro" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: "/tmp", access: "read_write" },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId },
  };
}

async function drain(
  segment: BackendRunSegment<"claude_code">,
): Promise<{ events: string[]; outcome: Awaited<ReturnType<(typeof segment.outcome)["then"]>> }> {
  const events: string[] = [];
  for await (const ev of segment.events) events.push(ev.type);
  return { events, outcome: await segment.outcome };
}

describe("ClaudeBackend", () => {
  test("text fixture completes with final answer from result", async () => {
    const ws = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    const log = join(ws, "log.json");
    const backend = makeBackend("claude-wire-text.jsonl", log);
    const { events, outcome } = await drain(await backend.execute(makeInput()));
    expect(events).toContain("text_delta");
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.messages?.at(-1)).toEqual({ role: "assistant", text: "OK" });
      expect(outcome.usage?.inputTokens).toBeGreaterThan(0);
    }
    // stdin carried one stream-json user message with the input text.
    const logData = JSON.parse(readFileSync(log, "utf8")) as { stdin: string };
    const stdinMsg = JSON.parse(logData.stdin) as {
      type: string;
      message: { role: string };
    };
    expect(stdinMsg.type).toBe("user");
    expect(stdinMsg.message.role).toBe("user");
    rmSync(ws, { recursive: true, force: true });
  });

  test("tool fixture completes with native tool events", async () => {
    const ws = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    const log = join(ws, "log.json");
    const backend = makeBackend("claude-wire-tool.jsonl", log);
    const { events, outcome } = await drain(await backend.execute(makeInput()));
    expect(events.filter((t) => t === "native_tool_started").length).toBeGreaterThanOrEqual(1);
    expect(outcome.status).toBe("completed");
    rmSync(ws, { recursive: true, force: true });
  });

  test("session id persisted after first run; --resume on second", async () => {
    const ws = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    const log = join(ws, "log.json");
    const backend = makeBackend("claude-wire-text.jsonl", log);
    const input = makeInput("branch-x");
    const withWs = { ...input, workspace: { root: ws, access: "read_write" as const } };
    await drain(await backend.execute(withWs));
    const first = JSON.parse(readFileSync(log, "utf8")) as { argv: string[] };
    expect(first.argv.some((a) => a.includes("--resume"))).toBe(false);
    // session id file written from the fixture's init/result events
    const sessionFile = join(ws, ".my-agent", "claude-session", "branch-x.json");
    const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as { sessionId: string };
    expect(stored.sessionId).toBe("0e491d46-b3a8-4e64-999a-400043c30f4e");
    // second run resumes with --resume <sessionId>
    await drain(await backend.execute(withWs));
    const second = JSON.parse(readFileSync(log, "utf8")) as { argv: string[] };
    expect(second.argv).toContain("--resume");
    expect(second.argv).toContain(stored.sessionId);
    rmSync(ws, { recursive: true, force: true });
  });

  test("steer is explicitly rejected (per-turn process)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    const backend = makeBackend("claude-wire-text.jsonl", join(ws, "log.json"));
    await expect(
      backend.steer("run-1", { inputId: "s1", message: { role: "user", text: "steer" } }),
    ).rejects.toThrow(ClaudeBackendError);
    rmSync(ws, { recursive: true, force: true });
  });
});

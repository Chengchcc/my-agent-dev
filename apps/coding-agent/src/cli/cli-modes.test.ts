import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgentOutput } from "@my-agent-team/agent-backend";

/** Spawned-process CLI tests: print mode, json mode, rpc mode and
 *  --list-models through the REAL entry (main.ts) with the fake provider.
 *  These are the process-level guarantees: stdout purity, one outcome,
 *  exit after outcome. */

const MAIN = new URL("../main.ts", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "cli-modes-"));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnCli(args: string[], env: Record<string, string> = {}): Promise<SpawnResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, MAIN, ...args],
    cwd: tmp,
    env: { ...process.env, CODING_AGENT_FAKE_PROVIDER: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

const EXECUTE = {
  id: "e1",
  type: "execute",
  input: {
    history: [],
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "r-cli-1",
      model: { backendKind: "coding_agent", modelId: "fake/echo" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentMemberId: "m", branchId: "b" },
  },
};

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("coding-agent CLI (spawned)", () => {
  test("print mode (-p): stdout is ONLY the final assistant text, exit 0", async () => {
    const res = await spawnCli(["-p", "fix this"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("done\n");
    // failures and logs go to stderr, never stdout
    expect(res.stdout.split("\n").length).toBe(2);
  }, 15_000);

  test("json mode (--mode json): all events + exactly one outcome as JSONL, exit 0", async () => {
    const res = await spawnCli(["--mode", "json", "fix this"]);
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const outputs = lines.map((l) => JSON.parse(l) as { type: string });
    expect(outputs[0]?.type).toBe("event");
    const outcomes = outputs.filter((o) => o.type === "outcome");
    expect(outcomes).toHaveLength(1);
    // every stdout line is JSONL (no stray logs)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 15_000);

  test("rpc mode: one execute -> success -> events -> outcome -> process exits", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, MAIN, "--mode", "rpc"],
      cwd: tmp,
      env: { ...process.env, CODING_AGENT_FAKE_PROVIDER: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin!.write(`${JSON.stringify(EXECUTE)}\n`);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const lines: string[] = [];
    // Consume stdout until the outcome envelope arrives.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) lines.push(line);
      }
      if (lines.some((l) => (JSON.parse(l) as { type?: string }).type === "outcome")) break;
    }
    // The child exits once stdin closes after the outcome.
    proc.stdin!.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const outputs = lines.map((l) => JSON.parse(l) as CodingAgentOutput);
    // protocol order: execute response first, outcome last
    expect(outputs[0]).toMatchObject({ type: "response", success: true });
    expect(outputs[outputs.length - 1]?.type).toBe("outcome");
    expect(outputs.filter((o) => o.type === "outcome")).toHaveLength(1);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 15_000);

  test("--list-models --json returns the canonical catalog and exits 0", async () => {
    const res = await spawnCli(["--list-models", "--json"]);
    expect(res.exitCode).toBe(0);
    const catalog = JSON.parse(res.stdout) as {
      backendKind: string;
      models: Array<{ id: string; available: boolean }>;
    };
    expect(catalog.backendKind).toBe("coding_agent");
    expect(catalog.models[0]).toMatchObject({ id: "fake/echo", available: true });
  }, 15_000);

  test("run failure exits non-zero with the error on stderr (no model provider)", async () => {
    const res = await spawnCli(["-p", "x"], { CODING_AGENT_FAKE_PROVIDER: "" });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  }, 15_000);
});

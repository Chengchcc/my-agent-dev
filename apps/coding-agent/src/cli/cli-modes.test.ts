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

async function spawnCli(
  args: string[],
  env: Record<string, string> = {},
  stdinText?: string,
): Promise<SpawnResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, MAIN, ...args],
    cwd: tmp,
    env: { ...process.env, CODING_AGENT_FAKE_PROVIDER: "1", ...env },
    // "ignore" = /dev/null: the child's readPipedStdin sees a closed non-TTY
    // stream and skips; explicit pipes are used by the piped-stdin tests.
    stdin: stdinText === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdinText !== undefined) {
    try {
      proc.stdin!.write(stdinText);
    } catch {
      // EPIPE: the child exited early (e.g. the 16 MiB bound) - expected.
    }
    try {
      proc.stdin!.end();
    } catch {
      /* already broken */
    }
  }
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
    // ... and --model selects the second catalog model (fake provider yields
    // "done2" for echo2), observable end to end.
    const res2 = await spawnCli(["--model", "fake/echo2", "-p", "x"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout).toBe("done2\n");
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
    // The child exits ON ITS OWN after the outcome - stdin stays open (the
    // process must not depend on the parent closing it).
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("child did not exit after outcome")), 10_000),
      ),
    ]);
    expect(exitCode).toBe(0);
    const outputs = lines.map((l) => JSON.parse(l) as CodingAgentOutput);
    // protocol: an execute success response exists (agent_start may precede
    // it), and the outcome is the terminal line.
    expect(outputs.some((o) => o.type === "response" && o.success === true)).toBe(true);
    expect(outputs[outputs.length - 1]?.type).toBe("outcome");
    expect(outputs.filter((o) => o.type === "outcome")).toHaveLength(1);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  }, 15_000);

  test("--list-models returns the canonical catalog as JSON and exits 0", async () => {
    const res = await spawnCli(["--list-models"]);
    expect(res.exitCode).toBe(0);
    const catalog = JSON.parse(res.stdout) as {
      backendKind: string;
      models: Array<{ id: string; available: boolean }>;
    };
    expect(catalog.backendKind).toBe("coding_agent");
    expect(catalog.models[0]).toMatchObject({ id: "fake/echo", available: true });
  }, 15_000);

  test("piped stdin only (no prompt) works in print mode", async () => {
    const res = await spawnCli(["-p"], {}, "error line 1\nerror line 2\n");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("done\n");
  }, 15_000);

  test("piped stdin + prompt are both accepted (stdin feeds the run)", async () => {
    const res = await spawnCli(["-p", "analyze"], {}, "the error log\n");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("done\n");
  }, 15_000);

  test("piped stdin works in json mode", async () => {
    const res = await spawnCli(["--mode", "json", "translate"], {}, "hello world\n");
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines.filter((l) => JSON.parse(l).type === "outcome")).toHaveLength(1);
  }, 15_000);

  test("no prompt and no piped stdin fails with exit 2", async () => {
    const res = await spawnCli(["-p"], {}, "");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("no prompt or piped stdin");
    expect(res.stdout).toBe("");
  }, 15_000);

  test("oversized piped stdin fails with exit 2 (16 MiB bound)", async () => {
    // A filler process feeds >16 MiB so an EPIPE on the test side cannot
    // fail the run: the filler dies of SIGPIPE silently when the child
    // exits at the bound.
    const filler = Bun.spawn({
      cmd: ["head", "-c", String(17 * 1024 * 1024), "/dev/zero"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const proc = Bun.spawn({
      cmd: [process.execPath, MAIN, "-p", "x"],
      cwd: tmp,
      env: { ...process.env, CODING_AGENT_FAKE_PROVIDER: "1" },
      stdin: filler.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    void filler.exited.catch(() => {});
    expect(exitCode).toBe(2);
    expect(stderr).toContain("16 MiB");
  }, 30_000);

  test("RPC mode does not pre-consume stdin (execute still reaches the protocol)", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, MAIN, "--mode", "rpc"],
      cwd: tmp,
      env: { ...process.env, CODING_AGENT_FAKE_PROVIDER: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin!.write(`${JSON.stringify(EXECUTE)}\n`);
    // stdin stays OPEN: if main() had pre-read it as piped input, the
    // execute command would be consumed and never answered.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawResponse = false;
    for (let i = 0; i < 100 && !sawResponse; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      sawResponse = buffer.includes('"type":"response"');
    }
    expect(sawResponse).toBe(true);
    proc.stdin!.end();
    expect(await proc.exited).toBe(0);
  }, 15_000);

  test("run failure exits non-zero with the error on stderr (no model provider)", async () => {
    const res = await spawnCli(["-p", "x"], { CODING_AGENT_FAKE_PROVIDER: "" });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  }, 15_000);
});

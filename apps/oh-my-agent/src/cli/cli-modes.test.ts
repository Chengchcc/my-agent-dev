import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { runPrintMode } from "../modes/print-mode.js";
import type { OmaOutput } from "../protocol/index.js";

/** Spawned-process CLI tests: print mode, json mode, rpc mode and
 *  --list-models through the REAL executable entry (cli.ts → runCli) with
 *  the fake provider. These are the process-level guarantees: stdout
 *  purity, one outcome, exit after outcome. */

const MAIN = new URL("../cli.ts", import.meta.url).pathname;
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
    env: { ...process.env, OMA_FAKE_PROVIDER: "1", ...env },
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
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "r-cli-1",
      model: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  },
};

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("oma CLI (spawned)", () => {
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

  test("print mode persists the completed turn to a session file", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-sess-"));
    const res = await spawnCli(["-p", "fix this"], { OMA_SESSION_DIR: sessionDir });
    expect(res.exitCode).toBe(0);
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(sessionDir, files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; message?: { role: string } });
    expect(lines[0]?.type).toBe("session");
    const msgs = lines.filter((l) => l.type === "message");
    // input (user) + final assistant message are persisted
    expect(msgs[0]?.message?.role).toBe("user");
    expect(msgs.some((m) => m.message?.role === "assistant")).toBe(true);
    rmSync(sessionDir, { recursive: true, force: true });
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
      env: { ...process.env, OMA_FAKE_PROVIDER: "1" },
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
    const outputs = lines.map((l) => JSON.parse(l) as OmaOutput);
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
    expect(catalog.backendKind).toBe("oma");
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
    expect(res.stderr).toContain("interactive TUI");
    expect(res.stderr).toContain("oma -p");
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
      env: { ...process.env, OMA_FAKE_PROVIDER: "1" },
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
      env: { ...process.env, OMA_FAKE_PROVIDER: "1" },
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
    // No fake provider AND no real credentials: the catalog registers no
    // provider regardless of the host shell's env.
    const res = await spawnCli(["-p", "x"], {
      OMA_FAKE_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  }, 15_000);
});

describe("print mode (in-process): memory persistence", () => {
  test("awaits the background learn pass before returning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-print-learn-"));
    const savedTitle = process.env.OMA_TITLE_ENABLED;
    process.env.OMA_TITLE_ENABLED = "0"; // keep the model-call count deterministic
    try {
      const replies = [
        "done",
        JSON.stringify({ facts: [{ content: "print mode learns", context: "cli" }] }),
        "## Summary",
      ];
      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider({
        id: "probe",
        name: "Probe",
        getModels: () => [
          {
            id: "m",
            name: "M",
            provider: "probe",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
        async *stream() {
          const reply = replies.shift() ?? "";
          yield { delta: { type: "text", text: reply } };
          yield { stopReason: "end_turn" };
        },
      });
      const code = await runPrintMode({ prompt: "hello", workspaceRoot: dir, modelRuntime });
      expect(code).toBe(0);
      // The one-shot process waited for the fire-and-forget learn pass: the
      // facts are on disk BEFORE the mode returns (previously the process
      // could exit first and kill the extraction mid-flight).
      const factsDir = join(dir, ".oma", "memory", "facts");
      expect(existsSync(factsDir)).toBe(true);
      const files = readdirSync(factsDir);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(factsDir, files[0]!), "utf8")).toContain("print mode learns");
    } finally {
      if (savedTitle === undefined) delete process.env.OMA_TITLE_ENABLED;
      else process.env.OMA_TITLE_ENABLED = savedTitle;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

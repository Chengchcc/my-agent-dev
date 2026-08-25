import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@chengchenccc/ai";
import { createModelRuntime, type ModelRuntime } from "@chengchenccc/ai";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { fakeProvider } from "../../core/runtime/fake-provider.js";
import { loadSessionMessages } from "../../core/session/session-file.js";
import type { OmaOutput } from "../../protocol/index.js";
import { runRpcMode } from "./rpc-mode.js";

/** In-process RPC mode tests: the full command/output protocol through the
 *  real Runtime (fake provider), driven over a manual stdin stream. The
 *  spawned-process variants (exit behavior, stdout purity) live in
 *  cli-modes.test.ts. */

const tmp = mkdtempSync(join(tmpdir(), "rpc-mode-test-"));
process.env.OMA_SESSION_DIR = join(tmp, "sessions");

const FAKE_MODEL: Model = {
  id: "echo",
  name: "Fake Echo",
  provider: "fake",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

/** Provider that keeps the loop live for `delayMs` so steer/abort can land
 *  while the run is running (the stock fake resolves instantly). */
function slowProvider(delayMs: number): Provider {
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(_model: Model, _messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      await new Promise((r) => setTimeout(r, delayMs));
      yield { delta: { type: "text", text: "done" } };
      yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  };
}

interface Harness {
  write(line: string): void;
  close(): void;
  lines: () => string[];
  exitCode: Promise<number>;
  stop(): void;
}

function makeHarness(opts: { slowMs?: number } = {}): Harness {
  const modelRuntime: ModelRuntime = createModelRuntime();
  modelRuntime.registerProvider(opts.slowMs ? slowProvider(opts.slowMs) : fakeProvider({}));
  let stdinController: ReadableStreamDefaultController<Uint8Array>;
  const stdin = new ReadableStream<Uint8Array>({
    start(c) {
      stdinController = c;
    },
  });
  const outLines: string[] = [];
  const logs: string[] = [];
  const ctrl = runRpcMode({
    modelRuntime,
    stdin,
    writeLine: (line) => outLines.push(line),
    log: (line) => logs.push(line),
  });
  const encoder = new TextEncoder();
  return {
    write(line) {
      stdinController.enqueue(encoder.encode(`${line}\n`));
    },
    close() {
      stdinController.close();
    },
    lines: () => [...outLines],
    exitCode: ctrl.promise,
    stop: () => ctrl.stop(),
  };
}

const EXECUTE = {
  id: "e1",
  type: "execute",
  input: {
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "r-1",
      model: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
      skillRoots: [],
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  },
};

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function parseLines(lines: string[]): OmaOutput[] {
  return lines.map((l) => JSON.parse(l) as OmaOutput);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("RPC mode (in-process)", () => {
  test("execute success only after the runtime accepts steer/abort; events follow", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    // agent_start may precede the acceptance response (live ⟹ acceptance);
    // the response itself is what gates steer/abort.
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "response" && o.id === "e1"));
    const response = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e1");
    expect(response).toMatchObject({
      id: "e1",
      type: "response",
      command: "execute",
      success: true,
    });
    // Acceptance implies the loop is live: steer/abort are routable with no
    // delay, and the process exits on its own after the outcome (no stdin
    // close needed).
    h.write(
      JSON.stringify({
        id: "s1",
        type: "steer",
        runId: "r-1",
        input: { inputId: "si-1", message: { role: "user", text: "steer" } },
      }),
    );
    h.write(JSON.stringify({ id: "a1", type: "abort", runId: "r-1" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    expect(await h.exitCode).toBe(0);
    const all = parseLines(h.lines());
    const steerResp = all.find((o) => o.type === "response" && o.id === "s1");
    const abortResp = all.find((o) => o.type === "response" && o.id === "a1");
    expect(steerResp).toMatchObject({ success: true });
    expect(abortResp).toMatchObject({ success: true });
    // Every line is JSONL; nothing else on stdout.
    for (const line of h.lines()) expect(() => JSON.parse(line)).not.toThrow();
  }, 10_000);

  test("a second execute is a protocol error", async () => {
    const h = makeHarness({ slowMs: 200 });
    // Both executes are buffered before the reader processes the first; the
    // second one must be rejected explicitly.
    h.write(JSON.stringify(EXECUTE));
    h.write(JSON.stringify({ ...EXECUTE, id: "e2" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.id === "e2"));
    const first = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e1");
    expect(first).toMatchObject({ success: true });
    const second = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "e2");
    expect(second).toMatchObject({ success: false });
    expect(second && "error" in second ? second.error : "").toMatch(/at most one execute/);
  }, 10_000);

  test("steer only enters the current Run (runId mismatch rejected)", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    h.write(
      JSON.stringify({
        id: "s1",
        type: "steer",
        runId: "other-run",
        input: { inputId: "si-1", message: { role: "user", text: "x" } },
      }),
    );
    await waitFor(() => parseLines(h.lines()).some((o) => o.id === "s1"));
    const steerResp = parseLines(h.lines()).find((o) => o.type === "response" && o.id === "s1");
    expect(steerResp).toMatchObject({ success: false });
    expect(steerResp && "error" in steerResp ? steerResp.error : "").toMatch(/no live run/);
  }, 10_000);

  test("abort terminates the current Run (outcome aborted)", async () => {
    const h = makeHarness({ slowMs: 400 });
    h.write(JSON.stringify(EXECUTE));
    await waitFor(() => h.lines().length > 0);
    h.write(JSON.stringify({ id: "a1", type: "abort", runId: "r-1" }));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    const outcome = parseLines(h.lines()).find((o) => o.type === "outcome");
    expect(outcome?.outcome.status).toBe("aborted");
  }, 10_000);

  test("malformed JSON gets a failure response and never pollutes the stdout protocol", async () => {
    const h = makeHarness();
    h.write("this is {not json\n");
    h.write(JSON.stringify(EXECUTE));
    await waitFor(() => parseLines(h.lines()).some((o) => o.type === "outcome"));
    for (const line of h.lines()) expect(() => JSON.parse(line)).not.toThrow();
    const failure = parseLines(h.lines()).find((o) => o.type === "response" && o.success === false);
    expect(failure).toBeDefined();
    expect(failure && "error" in failure ? failure.error : "").toMatch(/malformed/);
    const outcome = parseLines(h.lines()).find((o) => o.type === "outcome");
    expect(outcome).toBeDefined();
  }, 10_000);

  test("stdin EOF without execute exits non-zero", async () => {
    const h = makeHarness();
    h.close();
    expect(await h.exitCode).toBe(1);
  }, 10_000);

  test("session persists and resumes via cliSessionRef (ADR 0003 round trip)", async () => {
    // First run: fresh session. The outcome reports the session id; the
    // session file records the turn (user + assistant).
    const h1 = makeHarness();
    h1.write(JSON.stringify(EXECUTE));
    await waitFor(() => parseLines(h1.lines()).some((o) => o.type === "outcome"));
    expect(await h1.exitCode).toBe(0);
    const outcome1 = parseLines(h1.lines()).find((o) => o.type === "outcome");
    const ref = outcome1?.outcome.cliSessionRef;
    expect(typeof ref).toBe("string");
    expect(outcome1?.outcome.status).toBe("completed");

    const transcript = loadSessionMessages(ref as string);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript[0]?.role).toBe("user");
    expect(transcript.at(-1)?.role).toBe("assistant");

    // Second run: resume the branch's session reference. The transcript
    // becomes the run history; the file accumulates the second turn and the
    // outcome carries the SAME reference.
    const h2 = makeHarness();
    h2.write(
      JSON.stringify({
        ...EXECUTE,
        id: "e2",
        input: {
          ...EXECUTE.input,
          input: { inputId: "in-2", message: { role: "user", text: "continue" } },
          run: { ...EXECUTE.input.run, cliSessionRef: ref },
        },
      }),
    );
    await waitFor(() => parseLines(h2.lines()).some((o) => o.type === "outcome"));
    expect(await h2.exitCode).toBe(0);
    const outcome2 = parseLines(h2.lines()).find((o) => o.type === "outcome");
    expect(outcome2?.outcome.cliSessionRef).toBe(ref);

    const grown = loadSessionMessages(ref as string);
    expect(grown.length).toBeGreaterThanOrEqual(transcript.length + 2);
    expect(grown[0]?.role).toBe("user");
    expect(grown.at(-1)?.role).toBe("assistant");
    // The second user turn is present in the middle of the transcript.
    expect(
      grown.slice(transcript.length).some((m) => m.role === "user" && m.text === "continue"),
    ).toBe(true);
  }, 10_000);
});

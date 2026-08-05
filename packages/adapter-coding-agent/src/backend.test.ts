import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput } from "@my-agent-team/agent-backend";
import { CodingAgentBackend, CodingAgentProcessError } from "./backend.js";
import { CodingAgentModelCatalog } from "./model-catalog.js";
import type { CodingAgentCommandConfig } from "./process.js";

/** Adapter tests drive the REAL RPC protocol through a scripted fixture
 *  child (packages/adapter-coding-agent/src/__fixtures__/rpc-fixture.ts):
 *  spawn → stdin/stdout JSONL → responses/events/outcome → exit. */

const FIXTURE = new URL("./__fixtures__/rpc-fixture.ts", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "adapter-test-"));

function makeConfig(
  scenario: string,
  extra: Record<string, string> = {},
): CodingAgentCommandConfig {
  return {
    executable: process.execPath,
    args: [FIXTURE, "--mode", "rpc"],
    env: { RPC_FIXTURE_SCENARIO: scenario, ...extra },
  };
}

const INPUT: BackendRunInput<"coding_agent"> = {
  history: [{ productEntryId: "e1", message: { role: "user", text: "hi" } }],
  input: { inputId: "in-1", message: { role: "user", text: "go" } },
  run: {
    runId: "run-1",
    model: { backendKind: "coding_agent", modelId: "fake/echo" },
    productTools: [],
    configRevision: 1,
  },
  workspace: { root: tmp, access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};

function inputWith(runId: string): BackendRunInput<"coding_agent"> {
  return { ...INPUT, run: { ...INPUT.run, runId } };
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("CodingAgentBackend (child process)", () => {
  test("execute spawns a child and returns a segment only after acceptance", async () => {
    const record = join(tmp, "rec-execute.txt");
    const backend = new CodingAgentBackend(makeConfig("normal", { RPC_FIXTURE_RECORD: record }));
    const segment = await backend.execute(inputWith("r-exec"));
    expect(segment).toBeDefined();
    // The child recorded the execute BEFORE responding success: acceptance
    // implies the spawn + command round trip happened. (The record carries
    // the spawn cwd after the runId.)
    expect(readFileSync(record, "utf-8").trim().startsWith("execute r-exec ")).toBe(true);
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
    expect((outcome as { output?: { text?: string } }).output?.text).toBe("done");
  }, 10_000);

  test("cwd equals the Run workspace root", async () => {
    const marker = join(tmp, "cwd-marker.txt");
    const ws = join(tmp, "ws-root");
    mkdirSync(ws, { recursive: true });
    const backend = new CodingAgentBackend(
      makeConfig("normal", { RPC_FIXTURE_CWD_MARKER: marker }),
    );
    const segment = await backend.execute({
      ...inputWith("r-cwd"),
      workspace: { root: ws, access: "read_write" },
    });
    await segment.outcome;
    // The child's cwd is the canonicalized workspace (macOS /tmp -> /private/tmp):
    // compare canonical forms, never the raw string.
    expect(realpathSync(readFileSync(marker, "utf-8").trim())).toBe(realpathSync(ws));
  }, 10_000);

  test("events map through the shared mapper", async () => {
    const backend = new CodingAgentBackend(makeConfig("normal"));
    const segment = await backend.execute(inputWith("r-events"));
    const events: string[] = [];
    const collect = (async () => {
      for await (const ev of segment.events) events.push(ev.type);
    })();
    await segment.outcome;
    await collect;
    expect(events).toContain("text_delta");
    expect(events).toContain("status");
  }, 10_000);

  test("outcome resolves exactly once", async () => {
    const backend = new CodingAgentBackend(makeConfig("normal"));
    const segment = await backend.execute(inputWith("r-once"));
    const first = await segment.outcome;
    const second = await segment.outcome;
    expect(first).toBe(second);
    expect(first.status).toBe("completed");
  }, 10_000);

  test("steer writes to the same child stdin", async () => {
    const record = join(tmp, "rec-steer.txt");
    const backend = new CodingAgentBackend(
      makeConfig("normal", {
        RPC_FIXTURE_RECORD: record,
        RPC_FIXTURE_OUTCOME_DELAY_MS: "1500",
      }),
    );
    const segment = await backend.execute(inputWith("r-steer"));
    await backend.steer("r-steer", { inputId: "steer-1", message: { role: "user", text: "s" } });
    const lines = readFileSync(record, "utf-8").trim().split("\n");
    expect(lines).toContain("steer r-steer");
    await segment.outcome;
  }, 10_000);

  test("steer on a run with no live child fails explicitly", async () => {
    const backend = new CodingAgentBackend(makeConfig("normal"));
    await expect(
      backend.steer("ghost-run", { inputId: "s", message: { role: "user", text: "x" } }),
    ).rejects.toThrow(/no live child/);
  }, 10_000);

  test("steer rejection surfaces as an explicit conflict", async () => {
    const backend = new CodingAgentBackend(makeConfig("steer-error"));
    const segment = await backend.execute(inputWith("r-steer-rej"));
    await expect(
      backend.steer("r-steer-rej", { inputId: "s", message: { role: "user", text: "x" } }),
    ).rejects.toThrow(/steer requires a live run/);
    await segment.outcome;
  }, 10_000);

  test("stop sends abort and the outcome settles aborted", async () => {
    const record = join(tmp, "rec-stop.txt");
    const backend = new CodingAgentBackend(
      makeConfig("normal", {
        RPC_FIXTURE_RECORD: record,
        RPC_FIXTURE_OUTCOME_DELAY_MS: "5000",
      }),
    );
    const segment = await backend.execute(inputWith("r-stop"));
    await backend.stop("r-stop");
    const lines = readFileSync(record, "utf-8").trim().split("\n");
    expect(lines).toContain("abort r-stop");
    expect((await segment.outcome).status).toBe("aborted");
  }, 10_000);

  test("stop with a no-outcome child settles via bounded grace (never hangs)", async () => {
    const backend = new CodingAgentBackend(makeConfig("no-events"), { abortGraceMs: 400 });
    const segment = await backend.execute(inputWith("r-grace"));
    await backend.stop("r-grace");
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("aborted");
    expect(outcome.error).toContain("abort grace");
  }, 10_000);

  test("unexpected exit before acceptance settles failed and rejects execute", async () => {
    const backend = new CodingAgentBackend(makeConfig("exit-before-acceptance"));
    await expect(backend.execute(inputWith("r-pre"))).rejects.toThrow(CodingAgentProcessError);
    await expect(backend.execute(inputWith("r-pre"))).rejects.toThrow(/exited/);
  }, 10_000);

  test("unexpected exit before outcome settles failed with the stderr tail", async () => {
    const backend = new CodingAgentBackend(makeConfig("exit-before-outcome"));
    const segment = await backend.execute(inputWith("r-mid"));
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/exited/);
  }, 10_000);

  test("malformed stdout settles failed (protocol violation)", async () => {
    const backend = new CodingAgentBackend(makeConfig("malformed-stdout"));
    const segment = await backend.execute(inputWith("r-malformed"));
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/malformed stdout/);
  }, 10_000);

  test("stderr tail is bounded and secrets are redacted", async () => {
    const secret = "super-secret-token-abc123";
    const backend = new CodingAgentBackend(
      makeConfig("stderr-flood", {
        RPC_FIXTURE_SECRET: secret,
        TEST_SECRET_TOKEN: secret,
      }),
    );
    const segment = await backend.execute(inputWith("r-flood"));
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).not.toContain(secret);
    expect(outcome.error!.length).toBeLessThan(4_000);
  }, 10_000);

  test("executable missing surfaces spawn_failed (no fake backend)", async () => {
    const backend = new CodingAgentBackend({
      executable: "/nonexistent/coding-agent-binary",
    });
    await expect(backend.execute(inputWith("r-spawn"))).rejects.toThrow(/spawn/);
  }, 10_000);

  test("the child is reaped after the outcome", async () => {
    const backend = new CodingAgentBackend(makeConfig("normal"));
    const segment = await backend.execute(inputWith("r-reap"));
    await segment.outcome;
    // The handle is removed: a steer now fails with no live child.
    await expect(
      backend.steer("r-reap", { inputId: "s", message: { role: "user", text: "x" } }),
    ).rejects.toThrow(/no live child/);
  }, 10_000);
});

describe("CodingAgentModelCatalog", () => {
  test("list spawns --list-models --json and returns the canonical catalog", async () => {
    const catalog = new CodingAgentModelCatalog(makeConfig("normal"));
    const result = await catalog.list();
    expect(result.backendKind).toBe("coding_agent");
    expect(result.models[0]).toMatchObject({ id: "fake/echo", available: true });
    // cached: a second list is served from the instance cache
    const again = await catalog.list();
    expect(again).toBe(result);
  }, 10_000);

  test("missing executable surfaces an explicit error", async () => {
    const catalog = new CodingAgentModelCatalog({
      executable: "/nonexistent/coding-agent-binary",
    });
    await expect(catalog.list()).rejects.toThrow(/spawn/);
  }, 10_000);
});

describe("CodingAgentBackend spawn-slot limit (maxConcurrent)", () => {
  test("live children are bounded FIFO; queued executes spawn after a slot frees", async () => {
    const record = join(tmp, "rec-concurrent.txt");
    const backend = new CodingAgentBackend(
      makeConfig("normal", {
        RPC_FIXTURE_RECORD: record,
        RPC_FIXTURE_OUTCOME_DELAY_MS: "300",
      }),
      { maxConcurrent: 1 },
    );
    const first = backend.execute(inputWith("r-conc-1"));
    const second = backend.execute(inputWith("r-conc-2"));
    const [seg1, seg2] = await Promise.all([first, second]);
    const [o1, o2] = await Promise.all([seg1.outcome, seg2.outcome]);
    expect(o1.status).toBe("completed");
    expect(o2.status).toBe("completed");
    const lines = readFileSync(record, "utf-8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("execute "))).toEqual([
      "execute r-conc-1 " + realpathSync(tmp),
      "execute r-conc-2 " + realpathSync(tmp),
    ]);
  }, 10_000);

  test("stop() cancels a queued execute: the Run never spawns", async () => {
    const record = join(tmp, "rec-cancel.txt");
    const backend = new CodingAgentBackend(
      makeConfig("normal", {
        RPC_FIXTURE_RECORD: record,
        RPC_FIXTURE_OUTCOME_DELAY_MS: "500",
      }),
      { maxConcurrent: 1 },
    );
    const first = await backend.execute(inputWith("r-hold"));
    const queued = backend.execute(inputWith("r-cancel"));
    // Give the queue a beat to register, then stop the queued Run.
    await new Promise((r) => setTimeout(r, 50));
    await backend.stop("r-cancel");
    await expect(queued).rejects.toThrow(/stopped while waiting/);
    await first.outcome;
    const lines = readFileSync(record, "utf-8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("execute "))).toHaveLength(1);
    expect(lines[0]).toContain("r-hold");
  }, 10_000);
});

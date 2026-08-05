import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { CodingAgentLoopResult, CodingAgentSession, SessionStore } from "@my-agent-team/agent";
import { createInMemorySessionStore } from "@my-agent-team/agent";
import type { BackendInputMessage, ProjectedHistoryItem } from "@my-agent-team/agent-backend";
import { createModelRuntime } from "@my-agent-team/ai";
import { fakeProvider } from "./fake-provider.js";
import { type CodingRunRegistry, createCodingRunRegistry } from "./run-registry.js";
import type { RunRuntime, RunRuntimeDeps } from "./run-runtime.js";

const tmp = `/tmp/coding-registry-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });

/** Scripted fake session: emits agent_start, then startLoop hangs until
 *  stop() resolves it. Records steers/stops per run. */
interface FakeRunRecord {
  runId: string;
  store: SessionStore;
  steers: BackendInputMessage[];
  stops: number;
  startLoopCalls: number;
  session: CodingAgentSession;
  resolveLoop: ((r: CodingAgentLoopResult) => void) | null;
}

function makeRegistry(): { registry: CodingRunRegistry; records: FakeRunRecord[] } {
  const records: FakeRunRecord[] = [];
  const modelRuntime = createModelRuntime();
  modelRuntime.registerProvider(fakeProvider({ CODING_AGENT_FAKE_PROVIDER: "1" }));
  const registry = createCodingRunRegistry({
    workspaceRoots: [tmp],
    eventBufferSize: 100,
    modelRuntime,
    runtimeFactory: async (deps: RunRuntimeDeps): Promise<RunRuntime> => {
      const store = createInMemorySessionStore();
      const record: FakeRunRecord = {
        runId: deps.runId,
        store,
        steers: [],
        stops: 0,
        startLoopCalls: 0,
        session: null as never,
        resolveLoop: null,
      };
      let listener: (e: { type: string }) => void = () => {};
      const session = {
        sessionId: deps.runId,
        status: "running",
        startLoop: () => {
          record.startLoopCalls++;
          listener({ type: "agent_start" });
          return new Promise<CodingAgentLoopResult>((resolve) => {
            record.resolveLoop = resolve;
          });
        },
        startFollowUp: () => session.startLoop(),
        steer: (input: BackendInputMessage) => {
          record.steers.push(input);
        },
        stop: () => {
          record.stops++;
          record.resolveLoop?.({ status: "stopped", error: "stopped" });
        },
        compact: async () => {},
        onEvent: (l: (e: { type: string }) => void) => {
          listener = l;
          return () => {};
        },
      } as unknown as CodingAgentSession;
      record.session = session;
      records.push(record);
      return {
        runId: deps.runId,
        store,
        session,
        summarize: async () => "",
        contextBudget: undefined,
        setActiveRun() {},
        close: async () => {},
      };
    },
  });
  return { registry, records };
}

const HISTORY: readonly ProjectedHistoryItem[] = [
  { productEntryId: "e1", message: { role: "user", text: "hello" } },
];
const INPUT: BackendInputMessage = { inputId: "in-1", message: { role: "user", text: "go" } };

function runInput(runId: string, text = "go"): Parameters<CodingRunRegistry["execute"]>[0] {
  return {
    history: HISTORY,
    input: { inputId: `in-${runId}`, message: { role: "user", text } },
    run: {
      runId,
      model: { backendKind: "coding_agent", modelId: "fake/echo" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
  };
}

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

describe("coding run registry", () => {
  test("one execute creates one independent loop", async () => {
    const { registry, records } = makeRegistry();
    const res = await registry.execute(runInput("r1"));
    expect(res).toEqual({ runId: "r1", accepted: true });
    expect(records).toHaveLength(1);
    expect(records[0]!.startLoopCalls).toBe(1);
  });

  test("two different runIds run in parallel", async () => {
    const { registry, records } = makeRegistry();
    const [a, b] = await Promise.all([
      registry.execute(runInput("r1")),
      registry.execute(runInput("r2")),
    ]);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(records.map((r) => r.runId).sort()).toEqual(["r1", "r2"]);
    // Both loops are live at the same time (both startLoop promises pending).
    expect(records[0]!.startLoopCalls).toBe(1);
    expect(records[1]!.startLoopCalls).toBe(1);
  });

  test("two Runs do not share in-memory stores", async () => {
    const { registry, records } = makeRegistry();
    await registry.execute(runInput("r1"));
    await registry.execute(runInput("r2"));
    const [s1, s2] = [records[0]!.store, records[1]!.store];
    expect(s1).not.toBe(s2);
    // The registry seeds each Run's store; appending to one never leaks
    // into the other.
    await s1.appendBatch("r1", {
      entries: [
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "x" },
          createdAt: 1,
        },
      ],
    });
    expect((await s1.readBranch("r1")).length).toBe(1);
    expect((await s2.readBranch("r2")).length).toBe(0);
  });

  test("steer enters only the target live Run", async () => {
    const { registry, records } = makeRegistry();
    await registry.execute(runInput("r1"));
    await registry.execute(runInput("r2"));
    await registry.steer("r1", { inputId: "in-s", message: { role: "user", text: "steer" } });
    const byId = new Map(records.map((r) => [r.runId, r]));
    expect(byId.get("r1")!.steers.map((s) => s.inputId)).toEqual(["in-s"]);
    expect(byId.get("r2")!.steers).toHaveLength(0);
  });

  test("steer on a non-live run fails explicitly", async () => {
    const { registry } = makeRegistry();
    await expect(registry.steer("ghost", INPUT)).rejects.toThrow(/live run/);
    await registry.execute(runInput("r1"));
    await registry.stop("r1");
    // Settled run: steer must fail, never be silently converted.
    await expect(registry.steer("r1", INPUT)).rejects.toThrow(/live run/);
  });

  test("stop only terminates the target Run", async () => {
    const { registry, records } = makeRegistry();
    await registry.execute(runInput("r1"));
    await registry.execute(runInput("r2"));
    await registry.stop("r1");
    const byId = new Map(records.map((r) => [r.runId, r]));
    expect(byId.get("r1")!.stops).toBe(1);
    expect(byId.get("r2")!.stops).toBe(0);
    expect(registry.getOutcome("r1")).toMatchObject({ status: "aborted" });
    expect(registry.getOutcome("r2")).toBeNull();
  });

  test("same runId + same payload is idempotent (one loop)", async () => {
    const { registry, records } = makeRegistry();
    const input = runInput("r1");
    const first = await registry.execute(input);
    const second = await registry.execute({ ...input, history: [...input.history] });
    expect(second).toEqual(first);
    expect(records).toHaveLength(1);
    expect(records[0]!.startLoopCalls).toBe(1);
  });

  test("same runId + different payload conflicts", async () => {
    const { registry, records } = makeRegistry();
    await registry.execute(runInput("r1"));
    await expect(registry.execute(runInput("r1", "different text"))).rejects.toThrow(
      /different payload/i,
    );
    expect(records).toHaveLength(1);
  });

  test("outcome is unique (first-write-wins)", async () => {
    const { registry, records } = makeRegistry();
    await registry.execute(runInput("r1"));
    const byId = new Map(records.map((r) => [r.runId, r]));
    // Settle twice with different results: the first outcome wins.
    byId
      .get("r1")!
      .resolveLoop?.({ status: "completed", output: { role: "assistant", text: "a" } });
    // Wait for the outcome to be published.
    for (let i = 0; i < 50 && !registry.getOutcome("r1"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const first = registry.getOutcome("r1");
    expect(first).toMatchObject({ runId: "r1", status: "completed" });
    expect(registry.getOutcome("r1")).toBe(first);
  });

  test("invalid workspace rejected at acceptance", async () => {
    const { registry } = makeRegistry();
    const input = runInput("r1");
    const bad = {
      ...input,
      workspace: { root: "/nonexistent-outside-allowlist", access: "read_write" as const },
    };
    await expect(registry.execute(bad)).rejects.toThrow(/allowlist/);
  });
});

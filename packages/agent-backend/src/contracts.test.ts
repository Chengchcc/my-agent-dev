import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  ProjectedHistoryItem,
} from "./index.js";

async function* noEvents(): AsyncIterable<BackendEvent<"fake">> {}

function completedSegment(output?: Message): BackendRunSegment<"fake"> {
  const outcome: BackendRunOutcome = output
    ? { status: "completed", messages: [output] }
    : { status: "completed" };
  return {
    events: noEvents(),
    outcome: Promise.resolve(outcome),
    async stop() {},
  };
}

/** FakeBackend implements the three Run-centric AgentBackend methods with
 *  deterministic completed segments. No adapter base class. */
class FakeBackend implements AgentBackend<"fake"> {
  readonly kind = "fake" as const;

  async execute(input: BackendRunInput<"fake">): Promise<BackendRunSegment<"fake">> {
    expect(input.run.runId).toBe("run-1");
    expect(input.workspace.root).toBe("/tmp");
    expect(input.metadata?.branchId).toBe("b1");
    return completedSegment();
  }

  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {}

  async stop(_runId: string): Promise<void> {}

  async dispose(): Promise<void> {}
}

const RUN_SNAPSHOT = {
  runId: "run-1",
  model: { backendKind: "fake", modelId: "fake-1" },
  configRevision: 1,
} as const;

const INPUT: BackendInputMessage = {
  inputId: "in-1",
  message: { role: "user", text: "do the thing" },
};

const RUN_INPUT: BackendRunInput<"fake"> = {
  input: INPUT,
  run: RUN_SNAPSHOT,
  workspace: { root: "/tmp", access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};

describe("agent-backend contracts", () => {
  test("FakeBackend implements the three Run-centric methods", () => {
    const backend: AgentBackend<"fake"> = new FakeBackend();
    expect(backend.kind).toBe("fake");
    expect(typeof backend.execute).toBe("function");
    expect(typeof backend.steer).toBe("function");
    expect(typeof backend.stop).toBe("function");
  });

  test("barrel-only consumer consumes events and outcome from execute()", async () => {
    const backend: AgentBackend<"fake"> = new FakeBackend();
    const segment = await backend.execute(RUN_INPUT);
    for await (const _event of segment.events) {
      // no events emitted
    }
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
  });

  test("BackendRunInput carries the full Run facts (input/run/workspace/metadata)", () => {
    expect(RUN_INPUT.input.message).toBe(INPUT.message);
    expect(RUN_INPUT.run.runId).toBe("run-1");
    expect(RUN_INPUT.workspace.access).toBe("read_write");
    expect(RUN_INPUT.metadata?.conversationId).toBe("c1");
    expect(RUN_INPUT.metadata?.agentMemberId).toBe("m1");
  });

  test("input is the sole actual prompt; history is NOT part of the contract", () => {
    // ADR 0003 decision 6: the first-turn bridge is flat text INSIDE
    // input.message; the Backend must read `input.message` explicitly.
    expect("history" in RUN_INPUT).toBe(false);
    expect(RUN_INPUT.input.message).toBe(INPUT.message);
  });

  test("steer/stop are control-plane: no outcome of their own", () => {
    const backend: AgentBackend<"fake"> = new FakeBackend();
    expect(async () => await backend.steer("run-1", INPUT)).not.toThrow();
    expect(async () => await backend.stop("run-1")).not.toThrow();
  });

  test("package manifest allows only @chengchenccc/message and zod", async () => {
    const url = new URL("../package.json", import.meta.url);
    const pkg = await Bun.file(url).json();
    expect(pkg.dependencies).toEqual({
      "@chengchenccc/message": "workspace:*",
      // zod powers the neutral backend-kind schema and runtime validation.
      zod: "^3.23.0",
    });
    expect(pkg.devDependencies).toEqual({});
  });

  test("package runtime entry imports without missing exports", async () => {
    const module = await import("./index.js");
    // The barrel exposes the backend-agnostic contracts only.
    expect(module.BACKEND_KINDS).toBeDefined();
    expect(module.collectSecrets).toBeDefined();
  });

  test("extension events are namespaced to the backend kind", () => {
    // A FakeBackend ("fake") may emit backend.fake.* events.
    const ok: BackendEvent<"fake"> = {
      type: "backend.fake.tool_trace",
      payload: { detail: "x" },
    };
    expect(ok.type).toBe("backend.fake.tool_trace");
  });
});

// --- Negative type guards ---
// Each guard must fail to compile; @ts-expect-error proves the failure.
// These statements live at module scope so the typecheck gate exercises them.

// BackendRunInput without `run` is invalid. The error is on the declaration
// line (TS2741), so the directive sits directly above it.
// @ts-expect-error - missing required `run` field
const _noRun: BackendRunInput = { input: INPUT };

// BackendRunInput without `workspace` is invalid (workspace is a Run fact).
// @ts-expect-error - missing required `workspace` field
const _noWorkspace: BackendRunInput = {
  input: INPUT,
  run: RUN_SNAPSHOT,
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};
// @ts-expect-error - missing required `productEntryId` field
const _noProductEntryId: ProjectedHistoryItem = {
  message: { role: "user", text: "hello" },
};

// Extension event without an event segment (backend.oma) is invalid:
// the namespace requires backend.<kind>.<event>.
const _noEventSegment: BackendEvent<"oma"> =
  // @ts-expect-error - backend.oma lacks the <event> segment
  { type: "backend.oma", payload: {} };

// Extension event with the wrong kind is invalid for a backend of kind "fake":
// "claude" != "fake".
const _wrongKind: BackendEvent<"fake"> =
  // @ts-expect-error - backend.claude.tool_trace is not a "fake" extension event
  { type: "backend.claude.tool_trace", payload: {} };

// A Backend of kind "fake" cannot receive a "claude-code" run input: the
// model ref's backendKind must match the Backend's K. Pure type-level check:
const claudeInput: BackendRunInput<"claude-code"> = {
  input: INPUT,
  run: { ...RUN_SNAPSHOT, model: { backendKind: "claude-code", modelId: "x" } },
  workspace: { root: "/tmp", access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};
// @ts-expect-error - BackendRunInput<"claude-code"> is not assignable to BackendRunInput<"fake">
const _crossKind: BackendRunInput<"fake"> = claudeInput;

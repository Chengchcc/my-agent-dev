import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
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
    ? { status: "completed", output }
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
    expect(input.metadata.branchId).toBe("b1");
    return completedSegment();
  }

  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {}

  async stop(_runId: string): Promise<void> {}
}

const RUN_SNAPSHOT = {
  runId: "run-1",
  model: { backendKind: "fake", modelId: "fake-1" },
  productTools: [],
  configRevision: 1,
} as const;
const HISTORY: readonly ProjectedHistoryItem[] = [
  { productEntryId: "e1", message: { role: "user", text: "hello" } },
];

const INPUT: BackendInputMessage = {
  inputId: "in-1",
  message: { role: "user", text: "do the thing" },
};

const RUN_INPUT: BackendRunInput<"fake"> = {
  history: HISTORY,
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

  test("BackendRunInput carries the full Run facts (history/input/run/workspace/metadata)", () => {
    expect(RUN_INPUT.history).toBe(HISTORY);
    expect(RUN_INPUT.input.message).toBe(INPUT.message);
    expect(RUN_INPUT.run.runId).toBe("run-1");
    expect(RUN_INPUT.workspace.access).toBe("read_write");
    expect(RUN_INPUT.metadata.conversationId).toBe("c1");
    expect(RUN_INPUT.metadata.agentMemberId).toBe("m1");
  });

  test("history and input are distinct; input is never inferred from history", () => {
    // The contract has no path from history to input: a Backend must read
    // `input.message` explicitly. Confirm the field is required, not optional.
    const turn: BackendRunInput<"fake"> = {
      history: HISTORY,
      input: INPUT,
      run: RUN_SNAPSHOT,
      workspace: { root: "/tmp", access: "read_write" },
      metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
    };
    expect(turn.input.message).toBe(INPUT.message);
    expect(turn.history).not.toBe(turn.input);
  });

  test("steer/stop are control-plane: no outcome of their own", () => {
    const backend: AgentBackend<"fake"> = new FakeBackend();
    expect(async () => await backend.steer("run-1", INPUT)).not.toThrow();
    expect(async () => await backend.stop("run-1")).not.toThrow();
  });

  test("package manifest allows only @my-agent-team/message and zod", async () => {
    const url = new URL("../package.json", import.meta.url);
    const pkg = await Bun.file(url).json();
    expect(pkg.dependencies).toEqual({
      "@my-agent-team/message": "workspace:*",
      // zod powers the neutral transport wire contract (daemon + adapter
      // share these schemas without importing each other's implementation).
      zod: "^3.23.0",
    });
    expect(pkg.devDependencies).toEqual({});
  });

  test("package runtime entry imports without missing exports", async () => {
    const module = await import("./index.js");
    // The barrel exports the stdio JSONL wire contract next to the types.
    expect(module.executeCommandSchema).toBeDefined();
    expect(module.codingAgentOutputSchema).toBeDefined();
    expect(module.modelCatalogResponseSchema).toBeDefined();
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
const _noRun: BackendRunInput = { history: HISTORY, input: INPUT };

// BackendRunInput without `workspace` is invalid (workspace is a Run fact).
// @ts-expect-error - missing required `workspace` field
const _noWorkspace: BackendRunInput = {
  history: HISTORY,
  input: INPUT,
  run: RUN_SNAPSHOT,
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};

// ProjectedHistoryItem without `productEntryId` is invalid.
// @ts-expect-error - missing required `productEntryId` field
const _noProductEntryId: ProjectedHistoryItem = {
  message: { role: "user", text: "hello" },
};

// Extension event without an event segment (backend.coding_agent) is invalid:
// the namespace requires backend.<kind>.<event>.
const _noEventSegment: BackendEvent<"coding_agent"> =
  // @ts-expect-error - backend.coding_agent lacks the <event> segment
  { type: "backend.coding_agent", payload: {} };

// Extension event with the wrong kind is invalid for a backend of kind "fake":
// "claude" != "fake".
const _wrongKind: BackendEvent<"fake"> =
  // @ts-expect-error - backend.claude.tool_trace is not a "fake" extension event
  { type: "backend.claude.tool_trace", payload: {} };

// A Backend of kind "fake" cannot receive a "claude-code" run input: the
// model ref's backendKind must match the Backend's K. Pure type-level check:
const claudeInput: BackendRunInput<"claude-code"> = {
  history: HISTORY,
  input: INPUT,
  run: { ...RUN_SNAPSHOT, model: { backendKind: "claude-code", modelId: "x" } },
  workspace: { root: "/tmp", access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};
// @ts-expect-error - BackendRunInput<"claude-code"> is not assignable to BackendRunInput<"fake">
const _crossKind: BackendRunInput<"fake"> = claudeInput;

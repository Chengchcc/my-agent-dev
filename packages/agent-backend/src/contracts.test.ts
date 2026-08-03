import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import type {
  AgentBackend,
  AgentBackendCapabilities,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionRef,
  BackendSessionRun,
  BackendStartInput,
  PendingActionResponse,
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

/** Adapter-private session ref subtype carrying live state the public protocol
 *  never reads. Demonstrates the TRef extension point without leaking. */
interface FakeRef extends BackendSessionRef<"fake"> {
  readonly liveClient: unknown;
}

const SESSION: FakeRef = {
  backendSessionId: "session-1",
  backendKind: "fake",
  liveClient: {},
};

/** FakeBackend implements all six AgentBackend methods with deterministic
 *  completed segments. No adapter base class. */
class FakeBackend implements AgentBackend<"fake", FakeRef> {
  readonly kind = "fake" as const;
  readonly capabilities: AgentBackendCapabilities = {
    persistentSession: true,
    nativeResume: true,
    nativeSteer: true,
    thinkingStream: false,
    productTools: "mcp",
    pendingActionResponse: false,
  };

  async start(input: BackendStartInput<"fake">): Promise<BackendSessionRun<"fake", FakeRef>> {
    expect(input.run.runId).toBe("run-1");
    return { session: SESSION, segment: completedSegment() };
  }

  async send(
    _session: FakeRef,
    input: BackendRunInput<"fake">,
  ): Promise<BackendRunSegment<"fake">> {
    expect(input.run.runId).toBe("run-1");
    return completedSegment();
  }

  async resume(
    _backendSessionId: string,
    input: BackendStartInput<"fake">,
  ): Promise<BackendSessionRun<"fake", FakeRef>> {
    expect(input.run.runId).toBe("run-1");
    return { session: SESSION, segment: completedSegment() };
  }

  async respond(
    _session: FakeRef,
    _action: PendingActionResponse,
  ): Promise<BackendRunSegment<"fake">> {
    return completedSegment();
  }

  async stop(_session: FakeRef): Promise<void> {}

  async close(_session: FakeRef): Promise<void> {}
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

const START_INPUT: BackendStartInput<"fake"> = {
  history: HISTORY,
  input: INPUT,
  run: RUN_SNAPSHOT,
  workspace: { root: "/tmp", access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1", productRevision: 1 },
};

describe("agent-backend contracts", () => {
  test("FakeBackend implements all six methods", () => {
    const backend: AgentBackend<"fake", FakeRef> = new FakeBackend();
    expect(backend.kind).toBe("fake");
    expect(backend.capabilities.pendingActionResponse).toBe(false);
    expect(typeof backend.start).toBe("function");
    expect(typeof backend.send).toBe("function");
    expect(typeof backend.resume).toBe("function");
    expect(typeof backend.respond).toBe("function");
    expect(typeof backend.stop).toBe("function");
    expect(typeof backend.close).toBe("function");
  });

  test("barrel-only consumer consumes events and outcome from start()", async () => {
    const backend: AgentBackend<"fake", FakeRef> = new FakeBackend();
    const { session, segment } = await backend.start(START_INPUT);
    expect(session.backendSessionId).toBe("session-1");

    for await (const _event of segment.events) {
      // no events emitted
    }
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
  });

  test("send() continues an open session and resolves completed", async () => {
    const backend: AgentBackend<"fake", FakeRef> = new FakeBackend();
    const segment = await backend.send(SESSION, {
      history: [{ productEntryId: "e2", message: { role: "user", text: "ctx" } }],
      input: INPUT,
      run: RUN_SNAPSHOT,
      mode: "normal",
      metadata: { branchId: "b1", productRevision: 1 },
    });
    expect((await segment.outcome).status).toBe("completed");
  });

  test("BackendInputMessage carries blocks and inputId round-trip", () => {
    const rich: BackendInputMessage = {
      inputId: "in-2",
      message: {
        role: "user",
        blocks: [{ type: "text", text: "multi" }],
      },
      productEntryId: "e3",
    };
    expect(rich.inputId).toBe("in-2");
    expect(rich.message.blocks?.[0]?.type).toBe("text");
    expect(rich.productEntryId).toBe("e3");
  });

  test("history and input are distinct; input is never inferred from history", () => {
    // The contract has no path from history to input: a Backend must read
    // `input.message` explicitly. Confirm the field is required, not optional.
    const hist: readonly ProjectedHistoryItem[] = [
      { productEntryId: "e1", message: { role: "user", text: "past" } },
    ];
    const turn: BackendStartInput<"fake"> = {
      history: hist,
      input: INPUT,
      run: RUN_SNAPSHOT,
      workspace: { root: "/tmp", access: "read_write" },
      metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1", productRevision: 1 },
    };
    expect(turn.input.message).toBe(INPUT.message);
    expect(turn.history).not.toBe(turn.input);
  });

  test("suspended outcome carries a PendingAction", () => {
    const outcome: BackendRunOutcome = {
      status: "suspended",
      pendingAction: { actionId: "a1", kind: "approval", payload: {} },
    };
    expect(outcome.status).toBe("suspended");
    if (outcome.status === "suspended") {
      expect(outcome.pendingAction.actionId).toBe("a1");
    }
  });

  test("package manifest allows only @my-agent-team/message", async () => {
    const url = new URL("../package.json", import.meta.url);
    const pkg = await Bun.file(url).json();
    expect(pkg.dependencies).toEqual({
      "@my-agent-team/message": "workspace:*",
    });
    expect(pkg.devDependencies).toEqual({});
  });

  test("package runtime entry imports without missing exports", async () => {
    const module = await import("./index.js");
    expect(module).toEqual({});
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
const _noRun: BackendRunInput = {
  history: [],
  input: INPUT,
  mode: "normal",
  metadata: { branchId: "b1", productRevision: 1 },
};

// ProjectedHistoryItem without `productEntryId` is invalid.
// @ts-expect-error - missing required `productEntryId` field
const _noProductEntryId: ProjectedHistoryItem = {
  message: { role: "user", text: "hello" },
};

// Capabilities with `nativeFork` is invalid (excess property). The error is
// reported on the offending property line, so the directive sits above it.
const _nativeFork: AgentBackendCapabilities = {
  persistentSession: true,
  nativeResume: true,
  nativeSteer: true,
  thinkingStream: false,
  productTools: "mcp",
  pendingActionResponse: false,
  // @ts-expect-error - nativeFork is not a valid capability
  nativeFork: true,
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
  history: [],
  input: INPUT,
  run: {
    runId: "r2",
    model: { backendKind: "claude-code", modelId: "claude-sonnet" },
    productTools: [],
    configRevision: 1,
  },
  mode: "normal",
  metadata: { branchId: "b1", productRevision: 1 },
};
// @ts-expect-error - BackendRunInput<"claude-code"> is not assignable to BackendRunInput<"fake">
const _crossKind: BackendRunInput<"fake"> = claudeInput;

// Forbidden legacy names are not exported from the barrel. Each is imported in
// its own non-contiguous statement (separated by a no-op binding) so Biome's
// import-organize assist cannot merge them; @ts-expect-error proves each name
// is absent from the public API.
// @ts-expect-error - ProductTurn is not exported
import type { ProductTurn } from "./index.js";

const _sep1 = 0;

// @ts-expect-error - RuntimeBinding is not exported
import type { RuntimeBinding } from "./index.js";

const _sep2 = 0;

// @ts-expect-error - runtimeSessionId is not exported
import type { runtimeSessionId } from "./index.js";

const _sep3 = 0;

// @ts-expect-error - AgentSessionPool is not exported
import type { AgentSessionPool } from "./index.js";

const _sep4 = 0;

// @ts-expect-error - AgentLoop is not exported
import type { AgentLoop } from "./index.js";

const _sep5 = 0;

// @ts-expect-error - SpanResult is not exported
import type { SpanResult } from "./index.js";

const _sep6 = 0;

// @ts-expect-error - ExecutionId is not exported
import type { ExecutionId } from "./index.js";

// Reference the unused bindings so they are not flagged as dead code.
type _Unused = [
  ProductTurn,
  RuntimeBinding,
  runtimeSessionId,
  AgentSessionPool,
  AgentLoop,
  SpanResult,
  ExecutionId,
  typeof _noRun,
  typeof _noProductEntryId,
  typeof _nativeFork,
  typeof _noEventSegment,
  typeof _wrongKind,
  typeof _crossKind,
  typeof claudeInput,
  typeof _sep1,
  typeof _sep2,
  typeof _sep3,
  typeof _sep4,
  typeof _sep5,
  typeof _sep6,
];

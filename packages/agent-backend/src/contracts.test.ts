import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import type {
  AgentBackend,
  AgentBackendCapabilities,
  BackendEvent,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionHandle,
  BackendSessionRun,
  BackendStartInput,
  PendingActionResponse,
  ProjectedHistoryItem,
} from "./index.js";

async function* noEvents(): AsyncIterable<BackendEvent> {}

function completedSegment(output?: Message): BackendRunSegment {
  const outcome: BackendRunOutcome = output
    ? { status: "completed", output }
    : { status: "completed" };
  return {
    events: noEvents(),
    outcome: Promise.resolve(outcome),
    async stop() {},
  };
}

const SESSION: BackendSessionHandle = {
  backendSessionId: "session-1",
  backendKind: "fake",
  state: "open",
};

/** FakeBackend implements all six AgentBackend methods with deterministic
 *  completed segments. No adapter base class. */
class FakeBackend implements AgentBackend {
  readonly kind = "fake";
  readonly capabilities: AgentBackendCapabilities = {
    persistentSession: true,
    nativeResume: true,
    nativeSteer: true,
    thinkingStream: false,
    productTools: "mcp",
    pendingActionResponse: false,
  };

  async start(input: BackendStartInput): Promise<BackendSessionRun> {
    expect(input.run.runId).toBe("run-1");
    return { session: SESSION, segment: completedSegment() };
  }

  async send(_session: BackendSessionHandle, input: BackendRunInput): Promise<BackendRunSegment> {
    expect(input.run.runId).toBe("run-1");
    return completedSegment();
  }

  async resume(_backendSessionId: string, input: BackendStartInput): Promise<BackendSessionRun> {
    expect(input.run.runId).toBe("run-1");
    return { session: SESSION, segment: completedSegment() };
  }

  async respond(
    _session: BackendSessionHandle,
    _action: PendingActionResponse,
  ): Promise<BackendRunSegment> {
    return completedSegment();
  }

  async stop(_session: BackendSessionHandle): Promise<void> {}

  async close(_session: BackendSessionHandle): Promise<void> {}
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

describe("agent-backend contracts", () => {
  test("FakeBackend implements all six methods", () => {
    const backend: AgentBackend = new FakeBackend();
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
    const backend: AgentBackend = new FakeBackend();
    const { session, segment } = await backend.start({
      history: HISTORY,
      run: RUN_SNAPSHOT,
      workspace: { root: "/tmp", access: "read_write" },
      metadata: {
        conversationId: "c1",
        agentMemberId: "m1",
        branchId: "b1",
        productRevision: 1,
      },
    });
    expect(session.backendSessionId).toBe("session-1");

    for await (const _event of segment.events) {
      // no events emitted
    }
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
  });

  test("send() continues an open session and resolves completed", async () => {
    const backend: AgentBackend = new FakeBackend();
    const segment = await backend.send(SESSION, {
      messages: [{ productEntryId: "e2", message: { role: "user", text: "next" } }],
      run: RUN_SNAPSHOT,
      mode: "normal",
      metadata: { branchId: "b1", productRevision: 1 },
    });
    expect((await segment.outcome).status).toBe("completed");
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
});

// --- Negative type guards ---
// Each guard must fail to compile; @ts-expect-error proves the failure.
// These statements live at module scope so the typecheck gate exercises them.

// BackendRunInput without `run` is invalid. The error is on the declaration
// line (TS2741), so the directive sits directly above it.
// @ts-expect-error - missing required `run` field
const _noRun: BackendRunInput = {
  messages: [],
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
  typeof _sep1,
  typeof _sep2,
  typeof _sep3,
  typeof _sep4,
  typeof _sep5,
  typeof _sep6,
];

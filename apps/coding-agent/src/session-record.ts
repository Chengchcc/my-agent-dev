/** Daemon-local session record and legal lifecycle transitions. This is the
 *  single in-memory owner of per-session live state; it is NOT a database and
 *  NOT the source of truth for Agent Runs (that is Product Backend + the
 *  per-session SQLite file). */

export type SessionState = "starting" | "live" | "sleeping" | "stopping" | "closed" | "crashed";

export interface SessionRecord {
  readonly backendSessionId: string;
  state: SessionState;
  workerPid: number | null;
  activeRunId: string | null;
  workspaceRoot: string;
  /** Workspace access level established at start; gates tool installation. */
  workspaceAccess: "read_only" | "read_write";
  /** Product Tool manifest + call identity from the establishing run. */
  productTools: readonly {
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
    entrypoint: string;
  }[];
  productIdentity: {
    runId: string;
    conversationId: string;
    agentMemberId: string;
    branchId: string;
  };
  pendingCommands: Map<string, { commandId: string; idempotencyKey: string }>;
  lastActivityAt: number;
  /** Completed outcomes by runId (diagnostics + outcome endpoint). */
  completedOutcomes: Map<string, unknown>;
  /** True once a Worker exited unexpectedly for this session. */
  crashedAt: number | null;
}

export type SessionTransition = { from: SessionState; to: SessionState };

const LEGAL_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  starting: ["live", "stopping", "closed", "crashed"],
  live: ["sleeping", "stopping", "closed", "crashed", "starting"],
  sleeping: ["starting", "stopping", "closed", "crashed"],
  stopping: ["closed", "crashed"],
  closed: [],
  crashed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function createSessionRecord(backendSessionId: string): SessionRecord {
  return {
    backendSessionId,
    state: "starting",
    workerPid: null,
    activeRunId: null,
    workspaceRoot: "",
    workspaceAccess: "read_write",
    productTools: [],
    productIdentity: { runId: "", conversationId: "", agentMemberId: "", branchId: "" },
    pendingCommands: new Map(),
    lastActivityAt: Date.now(),
    completedOutcomes: new Map(),
    crashedAt: null,
  };
}

/** Transition a record, throwing on illegal transitions. */
export function transition(record: SessionRecord, to: SessionState): void {
  if (!canTransition(record.state, to)) {
    throw new Error(
      `illegal session transition ${record.state} -> ${to} for ${record.backendSessionId}`,
    );
  }
  record.state = to;
  record.lastActivityAt = Date.now();
}

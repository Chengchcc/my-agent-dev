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
  /** Run reserved but not yet accepted by the Worker. Events/outcomes for this
   *  run are accepted BEFORE activeRunId is set, closing the accepted+event
   *  same-chunk race. Cleared on acceptance (moved to activeRunId) or
   *  rejection (buffer rolled back). */
  pendingRunId: string | null;
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
  lastActivityAt: number;
  /** True once a Worker exited unexpectedly for this session. */
  crashedAt: number | null;
  /** Set while the Supervisor is deliberately shutting this session's Worker
   *  down (sleep/close): the resulting exit must not be marked crashed. */
  exiting: boolean;
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
    pendingRunId: null,
    workspaceRoot: "",
    workspaceAccess: "read_write",
    productTools: [],
    productIdentity: { runId: "", conversationId: "", agentMemberId: "", branchId: "" },
    lastActivityAt: Date.now(),
    crashedAt: null,
    exiting: false,
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

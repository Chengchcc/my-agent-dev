/** Daemon-local session record and legal lifecycle transitions. This is the
 *  single in-memory owner of per-session live state; it is NOT a database and
 *  NOT the source of truth for Agent Runs (that is Product Backend + the
 *  per-session SQLite file).
 *
 *  One-shot Worker model: a Worker exists only while its Run is executing.
 *  There is no long-lived Worker, no sleeping state, no wake path. Session
 *  continuity across Workers is guaranteed by the SQLite SessionStore, never
 *  by a resident process. */

export type SessionState = "idle" | "starting" | "running" | "closing" | "closed" | "crashed";

export interface SessionRecord {
  readonly backendSessionId: string;
  state: SessionState;
  /** Workspace binding established at start; gates tool installation and is
   *  enforced on every later resume/send. */
  workspaceRoot: string;
  workspaceAccess: "read_only" | "read_write";
  /** The run currently owned by the live Worker (at most one per session). */
  activeRunId: string | null;
  /** PID of the Worker executing the active run (or the maintenance Worker).
   *  null when no Worker is live. */
  workerPid: number | null;
  /** Session-level run identity carried on every run of this session
   *  (branchId/productRevision are per-Run and travel with the command). */
  conversationId: string;
  agentMemberId: string;
  lastActivityAt: number;
}

export type SessionTransition = { from: SessionState; to: SessionState };

const LEGAL_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  idle: ["starting", "closing", "crashed"],
  starting: ["running", "idle", "closing", "crashed"],
  running: ["idle", "closing", "crashed"],
  closing: ["closed", "crashed"],
  closed: [],
  crashed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function createSessionRecord(backendSessionId: string): SessionRecord {
  return {
    backendSessionId,
    state: "idle",
    workspaceRoot: "",
    workspaceAccess: "read_write",
    activeRunId: null,
    workerPid: null,
    conversationId: "",
    agentMemberId: "",
    lastActivityAt: Date.now(),
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

/** Pure transient-stream state transitions. The hook keeps the maps in
 *  React state; these functions make the multi-run merge/drop semantics
 *  unit-testable without DOM or EventSource. */

export interface TransientRun {
  text: string;
  agentMemberId: string;
}

export type TransientMap = Record<string, TransientRun>;

/** Append a delta to runId's bubble (creating it on first chunk). Other
 *  runs are untouched — no cross-run text bleed. */
export function appendTransient(
  state: TransientMap,
  runId: string,
  agentMemberId: string,
  delta: string,
): TransientMap {
  const next = { ...state };
  next[runId] = { text: `${state[runId]?.text ?? ""}${delta}`, agentMemberId };
  return next;
}

/** Drop exactly one run's bubble. */
export function removeTransient(state: TransientMap, runId: string): TransientMap {
  if (!(runId in state)) return state;
  const next = { ...state };
  delete next[runId];
  return next;
}

// ─── Live tool steps (Run-local, transient) ──────────────────────────────

export interface LiveToolCall {
  runId: string;
  callId: string;
  name: string;
  kind: "native" | "product";
  state: "running" | "done" | "error";
  result?: unknown;
}

/** Key: `<runId>:<callId>` — unique per tool invocation. */
export type LiveToolMap = Record<string, LiveToolCall>;

export function toolKey(runId: string, callId: string): string {
  return `${runId}:${callId}`;
}

/** A tool started: insert as running (upsert keeps later state). */
export function upsertTool(state: LiveToolMap, call: LiveToolCall): LiveToolMap {
  const next = { ...state };
  next[toolKey(call.runId, call.callId)] = call;
  return next;
}

/** A tool completed: mark done (or error when isError), keep the result. */
export function completeTool(
  state: LiveToolMap,
  runId: string,
  callId: string,
  result: unknown,
  isError: boolean,
): LiveToolMap {
  const key = toolKey(runId, callId);
  const cur = state[key];
  if (!cur) return state;
  const next = { ...state };
  next[key] = { ...cur, state: isError ? "error" : "done", result };
  return next;
}

/** Remove every tool of one run (run ended). */
export function clearRunTools(state: LiveToolMap, runId: string): LiveToolMap {
  const next: LiveToolMap = {};
  for (const [k, v] of Object.entries(state)) {
    if (v.runId !== runId) next[k] = v;
  }
  return Object.keys(next).length === Object.keys(state).length ? state : next;
}

// ─── Run-local todos ─────────────────────────────────────────────────────

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "done" | "cancelled";
}

/** runId -> full todo snapshot (todo_write sends the whole state). */
export type RunTodoMap = Record<string, readonly TodoItem[]>;

export function setRunTodos(
  state: RunTodoMap,
  runId: string,
  items: readonly TodoItem[],
): RunTodoMap {
  const next = { ...state };
  next[runId] = items;
  return next;
}

export function clearRunTodos(state: RunTodoMap, runId: string): RunTodoMap {
  if (!(runId in state)) return state;
  const next = { ...state };
  delete next[runId];
  return next;
}

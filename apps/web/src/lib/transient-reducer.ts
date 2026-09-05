/** Pure transient-stream state transitions. The hook keeps the maps in
 *  React state; these functions make the multi-run merge/drop semantics
 *  unit-testable without DOM or EventSource. */

export type TransientBlock = { type: "text" | "thinking"; text: string };

export interface TransientRun {
  text: string;
  /** Streaming model thinking (internal monologue), accumulated per run.
   *  Rendered inside the running trace; never part of the text bubble. */
  thinking: string;
  /** Interleaved thinking/text deltas in the exact order they arrived.
   *  Without this the UI cannot show reasoning interleaved with spoken
   *  text — it would lump all thinking above the text. */
  ordered: TransientBlock[];
  agentId: string;
  /** Runtime notices (stream-rule triggers): transient status lines shown
   * above the run's output; never part of the text bubble. */
  notices?: string[];
  /** Pending HITL approval (spec: approval pipeline). The web confirm card
   *  renders from this; resolving or run end clears it. */
  approval?: {
    callId: string;
    toolName: string;
    reason: string;
  };
  /** Pending ask_question (ADR 0027, HITL ask pipeline). The web AskQuestionCard
   *  renders from this; resolving or run end clears it. */
  ask?: {
    callId: string;
    questions: unknown[];
  };
  /** Terminal failure of this run (status event error field). Kept live
   *  because failed runs persist no assistant message. */
  error?: string;
}

export type TransientMap = Record<string, TransientRun>;

/** Append a delta to runId's bubble (creating it on first chunk). Other
 *  runs are untouched — no cross-run text bleed. */
export function appendTransient(
  state: TransientMap,
  runId: string,
  agentId: string,
  delta: string,
): TransientMap {
  const next = { ...state };
  next[runId] = {
    text: `${state[runId]?.text ?? ""}${delta}`,
    thinking: state[runId]?.thinking ?? "",
    ordered: [...(state[runId]?.ordered ?? []), { type: "text" as const, text: delta }],
    agentId,
  };
  return next;
}

/** Append a thinking delta to runId (creating the entry on first chunk). */
export function appendThinking(
  state: TransientMap,
  runId: string,
  agentId: string,
  delta: string,
): TransientMap {
  const next = { ...state };
  next[runId] = {
    text: state[runId]?.text ?? "",
    thinking: `${state[runId]?.thinking ?? ""}${delta}`,
    ordered: [...(state[runId]?.ordered ?? []), { type: "thinking" as const, text: delta }],
    agentId,
  };
  return next;
}

/** Drop exactly one run's bubble. */
export function removeTransient(state: TransientMap, runId: string): TransientMap {
  if (!(runId in state)) return state;
  const next = { ...state };
  delete next[runId];
  return next;
}

/** Mark a run terminal-failed: keep its text, attach the error. Callers
 *  decide when the bubble leaves (never auto-dropped on failure). */
export function markTransientError(
  state: TransientMap,
  runId: string,
  agentId: string,
  error: string,
): TransientMap {
  const next = { ...state };
  next[runId] = {
    text: state[runId]?.text ?? "",
    thinking: state[runId]?.thinking ?? "",
    ordered: state[runId]?.ordered ?? [],
    agentId,
    error,
  };
  return next;
}

/** Append a runtime notice to runId (creating the entry on first notice).
 * ponytail: capped at 5 per run — a rule storm must not grow the array. */
export function pushTransientNotice(
  state: TransientMap,
  runId: string,
  agentId: string,
  notice: string,
): TransientMap {
  const next = { ...state };
  const notices = [...(state[runId]?.notices ?? []), notice].slice(-5);
  next[runId] = {
    text: state[runId]?.text ?? "",
    thinking: state[runId]?.thinking ?? "",
    ordered: state[runId]?.ordered ?? [],
    agentId,
    notices,
  };
  return next;
}

/** Set (or replace) the pending approval on runId. */
export function setTransientApproval(
  state: TransientMap,
  runId: string,
  agentId: string,
  approval: { callId: string; toolName: string; reason: string },
): TransientMap {
  const next = { ...state };
  next[runId] = {
    text: state[runId]?.text ?? "",
    thinking: state[runId]?.thinking ?? "",
    ordered: state[runId]?.ordered ?? [],
    agentId,
    ...(state[runId]?.notices ? { notices: state[runId].notices } : {}),
    approval,
  };
  return next;
}

/** Clear the pending approval (resolved or run ended). */
export function clearTransientApproval(state: TransientMap, runId: string): TransientMap {
  const entry = state[runId];
  if (!entry?.approval) return state;
  const next = { ...state };
  const { approval: _drop, ...rest } = entry;
  next[runId] = rest;
  return next;
}

/** Set (or replace) the pending ask_question on runId. */
export function setTransientAsk(
  state: TransientMap,
  runId: string,
  agentId: string,
  ask: { callId: string; questions: unknown[] },
): TransientMap {
  const next = { ...state };
  next[runId] = {
    text: state[runId]?.text ?? "",
    thinking: state[runId]?.thinking ?? "",
    ordered: state[runId]?.ordered ?? [],
    agentId,
    ...(state[runId]?.notices ? { notices: state[runId].notices } : {}),
    ask,
  };
  return next;
}

/** Clear the pending ask (answered or run ended). */
export function clearTransientAsk(state: TransientMap, runId: string): TransientMap {
  const entry = state[runId];
  if (!entry?.ask) return state;
  const next = { ...state };
  const { ask: _drop, ...rest } = entry;
  next[runId] = rest;
  return next;
}

export interface LiveToolCall {
  runId: string;
  callId: string;
  name: string;
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

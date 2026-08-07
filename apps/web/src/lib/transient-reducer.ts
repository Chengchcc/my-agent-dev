/** Pure transient-stream state transitions. The hook keeps the map in
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

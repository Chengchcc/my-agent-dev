import type { OmaLoopEvent } from "@chengchenccc/agent";
import type { BackendRunOutcome } from "@chengchenccc/agent-backend";

/** Pure view model for the TUI transcript: folds OmaLoopEvents into the
 *  lines the renderer draws. No terminal I/O - fully unit-testable. */

export interface TranscriptItem {
  kind: "user" | "assistant" | "thinking" | "tool" | "status" | "error";
  /** For assistant/thinking: the accumulated text. For tool: "name summary".
   *  For user: the input text. For status/error: the message. */
  text: string;
  /** Streaming items grow in place; settled items are immutable. */
  streaming: boolean;
  /** Tool items only: the model call args (from tool_execution_start). */
  input?: Readonly<Record<string, unknown>>;
  /** Tool items only: the execution result (from tool_execution_end). */
  result?: Readonly<Record<string, unknown>>;
}

/** One completed or in-flight run as shown in the transcript. */
export interface RunViewState {
  /** Items of this run, in order. */
  items: TranscriptItem[];
  /** True between agent_start and agent_end. */
  running: boolean;
}

export interface TuiViewState {
  runs: RunViewState[];
  /** ctrl+t: show full thinking blocks (default: collapsed first line). */
  showThinking: boolean;
  /** ctrl+o: show full tool args/result JSON (default: one-line previews). */
  showToolDetail: boolean;
}

export function initialViewState(): TuiViewState {
  return { runs: [], showThinking: false, showToolDetail: false };
}

function currentRun(state: TuiViewState): RunViewState | undefined {
  return state.runs.at(-1);
}

function ensureRunningRun(state: TuiViewState): RunViewState {
  const run = currentRun(state);
  if (run?.running) return run;
  const fresh: RunViewState = { items: [], running: true };
  state.runs.push(fresh);
  return fresh;
}

function lastOfKind(run: RunViewState, kind: TranscriptItem["kind"]): TranscriptItem | undefined {
  for (let i = run.items.length - 1; i >= 0; i--) {
    const item = run.items[i]!;
    if (item.kind === kind && item.streaming) return item;
  }
  return undefined;
}

/** Fold one event into the view state (mutates for efficiency - the state
 *  is rebuilt per session, not diffed). */
export function applyEvent(state: TuiViewState, event: OmaLoopEvent): void {
  switch (event.type) {
    case "agent_start":
    case "turn_start": {
      ensureRunningRun(state);
      break;
    }
    case "message_start": {
      const run = ensureRunningRun(state);
      run.items.push({ kind: "assistant", text: "", streaming: true });
      break;
    }
    case "message_update": {
      const run = currentRun(state);
      const item = run && lastOfKind(run, "assistant");
      if (item) item.text += event.text;
      break;
    }
    case "thinking_update": {
      const run = ensureRunningRun(state);
      let item = lastOfKind(run, "thinking");
      if (!item) {
        item = { kind: "thinking", text: "", streaming: true };
        run.items.push(item);
      }
      item.text += event.text;
      break;
    }
    case "message_end":
    case "turn_end":
    case "compaction_end":
    case "retry_end": {
      // A finished assistant message settles its thinking block: the next
      // turn's reasoning must not append to the previous turn's.
      const run = currentRun(state);
      for (const item of run?.items ?? []) {
        if (item.kind === "thinking") item.streaming = false;
      }
      break;
    }
    case "tool_execution_start": {
      const run = ensureRunningRun(state);
      const item: TranscriptItem = {
        kind: "tool",
        text: `${event.toolName}…`,
        streaming: true,
      };
      if (event.input !== undefined) item.input = event.input;
      run.items.push(item);
      break;
    }
    case "tool_execution_end": {
      const run = currentRun(state);
      // Close the most recent streaming tool item.
      for (let i = run?.items.length ? run.items.length - 1 : -1; i >= 0; i--) {
        const item = run!.items[i]!;
        if (item.kind === "tool" && item.streaming) {
          item.streaming = false;
          item.text = `${event.toolName}`;
          if (event.result !== undefined) item.result = event.result;
          break;
        }
      }
      break;
    }
    case "retry_start": {
      const run = ensureRunningRun(state);
      run.items.push({
        kind: "status",
        text: `retry (attempt ${event.attempt})`,
        streaming: false,
      });
      break;
    }
    case "compaction_start": {
      const run = ensureRunningRun(state);
      run.items.push({ kind: "status", text: "compacting context…", streaming: false });
      break;
    }
    case "agent_end": {
      const run = currentRun(state);
      if (run) run.running = false;
      // Settle all streaming items.
      for (const item of run?.items ?? []) item.streaming = false;
      break;
    }
    // todo/queue/recap/workflow events: no v1 transcript rendering.
    default:
      break;
  }
}

/** Fold a terminal outcome into the view state. */
export function applyOutcome(state: TuiViewState, outcome: BackendRunOutcome): void {
  const run = currentRun(state);
  if (run) run.running = false;
  const runs = state.runs;
  if (outcome.status === "failed") {
    runs.push({
      items: [{ kind: "error", text: outcome.error ?? "run failed", streaming: false }],
      running: false,
    });
  } else if (outcome.status === "aborted") {
    runs.push({
      items: [{ kind: "status", text: "aborted", streaming: false }],
      running: false,
    });
  }
}

/** Add the user's input echo to the transcript before a run starts. */
export function addUserInput(state: TuiViewState, text: string): void {
  state.runs.push({ items: [{ kind: "user", text, streaming: false }], running: false });
}

/** True while the last run is live (editor submits become steer). */
export function isRunLive(state: TuiViewState): boolean {
  return currentRun(state)?.running ?? false;
}

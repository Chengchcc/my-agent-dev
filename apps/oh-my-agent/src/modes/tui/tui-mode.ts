import { randomUUID } from "node:crypto";
import type { OmaLoopEvent } from "@chengchenccc/agent";
import type { BackendRunInput, BackendRunOutcome } from "@chengchenccc/agent-backend";
import type { ModelRuntime } from "@chengchenccc/ai";
import {
  Container,
  Editor,
  type EditorTheme,
  ProcessTerminal,
  type Terminal,
  Text,
  TUI,
} from "@chengchenccc/tui";
import { buildCliRunInput } from "../../cli/initial-input.js";
import { createOmaRuntime } from "../../core/create-runtime.js";
import { persistSessionTurn, resolveSession } from "../../core/session-loop.js";
import {
  addUserInput,
  applyEvent,
  applyOutcome,
  initialViewState,
  type TranscriptItem,
  type TuiViewState,
} from "./view-state.js";

/** TUI mode: oma's standalone interactive surface. One process = N
 *  consecutive Runs over ONE session file; each Run is its own Runtime
 *  (one Runtime = one Run invariant preserved). Enter submits; a submit
 *  while a Run is live steers it; Ctrl-C aborts the live Run; /exit quits.
 *
 *  All terminal wiring lives behind the TerminalIo seam so tests can drive
 *  the whole loop headlessly. */

export interface TuiModeOptions {
  modelRuntime: ModelRuntime;
  workspaceRoot: string;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  model?: string;
  /** Resume a specific session file instead of starting fresh. */
  sessionId?: string;
}

/** The seam between the run loop and the terminal. */
export interface TuiIo {
  /** Render the current view state. */
  render(state: TuiViewState): void;
  /** Wait for the next user submit; resolves null on quit (Ctrl-D / /exit).
   *  Submits that arrive while a run is live (busy) are delivered to
   *  onLiveInput instead - waitForInput only resolves between runs. */
  waitForInput(): Promise<string | null>;
  /** Called once when a run goes live or settles, to toggle input mode. */
  setBusy?(busy: boolean): void;
  /** Subscriber for inputs submitted while a run is live (steer). */
  onLiveInput?(handler: ((text: string) => void) | null): void;
  /** Stop the terminal (restore modes). */
  close(): void;
}

/** Tool display caps: args are short; results get truncated so a huge tool
 *  output (e.g. a big bash stdout) cannot flood the transcript. */
const MAX_TOOL_ARGS = 200;
const MAX_TOOL_RESULT = 2_000;

/** Compact JSON for the tool header; pretty JSON (multi-line) for results so
 *  nested fields stay readable. Truncated with an ellipsis marker. */
function compactJson(value: unknown, max: number): string {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

const EDITOR_THEME: EditorTheme = {
  borderColor: (s) => s,
  // ponytail: selectList theme is required by the type but unused without
  // autocomplete providers; the empty object shape satisfies it.
  selectList: {} as EditorTheme["selectList"],
};

/** The full interactive session loop, driver-agnostic. */
export async function runTuiSession(opts: TuiModeOptions, io: TuiIo): Promise<number> {
  const session = resolveSession(opts.sessionId);
  const state = initialViewState();
  let modelId = opts.model;

  for (;;) {
    io.render(state);
    const input = await io.waitForInput();
    if (input === null) return 0;
    const text = input.trim();
    if (!text) continue;

    if (text === "/exit") return 0;
    if (text === "/session") {
      state.runs.push({
        items: [{ kind: "status", text: session.sessionId, streaming: false }],
        running: false,
      });
      continue;
    }
    if (text.startsWith("/model ")) {
      modelId = text.slice("/model ".length).trim();
      state.runs.push({
        items: [{ kind: "status", text: `model: ${modelId}`, streaming: false }],
        running: false,
      });
      continue;
    }

    addUserInput(state, text);
    const inputMessage = { role: "user", text } as const;

    const built = await buildCliRunInput({
      prompt: text,
      workspaceRoot: opts.workspaceRoot,
      modelRuntime: opts.modelRuntime,
      modelId,
    });
    const runtime = await createOmaRuntime({
      runId: `tui-${randomUUID()}`,
      modelId: built.run.model.modelId,
      workspaceRoot: opts.workspaceRoot,
      workspaceAccess: "read_write",
      modelRuntime: opts.modelRuntime,
      skillRoots: built.run.skillRoots ?? [],
      sessionTranscript: session.messages.length
        ? session.messages.map((m, i) => ({
            productEntryId: `session:${i}`,
            message: m as never,
          }))
        : undefined,
      // Render on every event so model chunks (message_update) hit the
      // screen incrementally; the TUI's requestRender throttles/coalesces,
      // so high-frequency chunk events are safe here.
      onEvent: (envelope) => {
        applyEvent(state, envelope.data as OmaLoopEvent);
        io.render(state);
      },
    });

    io.setBusy?.(true);
    let outcome: BackendRunOutcome;
    try {
      // Steer: a submit while the run is live routes into runtime.steer().
      const steerHandler = (text: string): void => {
        void runtime
          .steer({
            inputId: `steer-${randomUUID()}`,
            message: { role: "user", text },
          })
          .catch(() => {
            /* loop not accepting steer (settling): drop */
          });
      };
      io.onLiveInput?.(steerHandler);
      const segment = await runtime.run(built as BackendRunInput<"oma">);
      outcome = await segment.outcome;
      io.onLiveInput?.(null);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      io.onLiveInput?.(null);
    }
    applyOutcome(state, outcome);
    io.setBusy?.(false);

    if (outcome.status === "completed" && outcome.messages?.length) {
      session.messages = await persistSessionTurn({
        sessionId: session.sessionId,
        cwd: opts.workspaceRoot,
        runtime,
        outcomeMessages: outcome.messages as unknown[],
        inputMessage,
        previousMessages: session.messages,
      });
    }
    await runtime.close().catch(() => {});
  }
}

/** Production TuiIo over the real terminal. The optional terminal override
 *  is the test seam: e2e tests inject a VirtualTerminal (xterm headless). */
export function createTerminalIo(terminal: Terminal = new ProcessTerminal()): TuiIo {
  const tui = new TUI(terminal);
  const transcript = new Container();
  const editor = new Editor(tui, EDITOR_THEME);
  let pending: ((value: string | null) => void) | null = null;
  let busy = false;
  let liveHandler: ((text: string) => void) | null = null;

  editor.onSubmit = (text) => {
    if (busy) {
      if (liveHandler && text.trim()) liveHandler(text.trim());
      return;
    }
    if (!pending) return;
    const resolve = pending;
    pending = null;
    if (text === "/exit" || text === "/quit") resolve(null);
    else resolve(text);
  };

  function render(state: TuiViewState): void {
    transcript.clear();
    const lines: string[] = [];
    for (const run of state.runs) {
      for (const item of run.items) lines.push(...renderItem(item));
    }
    for (const line of lines) transcript.addChild(new Text(line, undefined, 1));
    tui.requestRender();
  }

  function renderItem(item: TranscriptItem): string[] {
    switch (item.kind) {
      case "user":
        return [`\u001b[36m> ${item.text}\u001b[0m`];
      case "assistant":
        return item.text ? [item.text] : [];
      case "thinking":
        // Full thinking text; the Text component wraps long lines. No
        // truncation - a one-line dim preview hid the reasoning.
        return item.text ? [`\u001b[2m${item.text}\u001b[0m`] : [];
      case "tool": {
        const args = item.input !== undefined ? ` ${compactJson(item.input, MAX_TOOL_ARGS)}` : "";
        const lines = [`\u001b[33m  \u2022 ${item.text}${args}\u001b[0m`];
        if (item.result !== undefined) {
          const result = compactJson(item.result, MAX_TOOL_RESULT);
          for (const line of result.split("\n")) {
            lines.push(`\u001b[2m    ${line}\u001b[0m`);
          }
        }
        return lines;
      }
      case "status":
        return [`\u001b[2m  [${item.text}]\u001b[0m`];
      case "error":
        return [`\u001b[31m  error: ${item.text}\u001b[0m`];
    }
  }

  tui.addChild(transcript);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();

  return {
    render,
    waitForInput() {
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },
    setBusy(next: boolean) {
      busy = next;
    },
    onLiveInput(handler) {
      liveHandler = handler;
    },
    close() {
      tui.stop();
    },
  };
}

/** CLI entry: run the interactive session over the real terminal. */
export async function runTuiMode(opts: TuiModeOptions): Promise<number> {
  const io = createTerminalIo();
  try {
    return await runTuiSession(opts, io);
  } finally {
    io.close();
  }
}

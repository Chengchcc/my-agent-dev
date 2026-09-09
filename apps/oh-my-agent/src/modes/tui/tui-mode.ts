import { randomUUID } from "node:crypto";
import type {
  AskQuestionInput,
  AskQuestionResult,
  BackendRunInput,
  BackendRunOutcome,
} from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import { ProcessTerminal, type SlashCommand } from "@chengchenccc/tui";
import { buildCliRunInput } from "../../cli/initial-input.js";
import type { OmaLoopEvent } from "../../core/agent-runtime.js";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import type { ToolFilter } from "../../core/runtime/tool-filter.js";
import {
  appendSessionMessages,
  listSessions,
  type SessionBranchNode,
} from "../../core/session/session-file.js";
import { persistSessionTurn, resolveSession } from "../../core/session/session-loop.js";
import { loadProjectSettings, type ProjectSettings } from "../../core/settings/project-settings.js";
import { buildCommands, type TuiSessionContext } from "./tui-commands.js";
import { formatTokens } from "./tui-format.js";
import {
  forkTreeInteractive,
  lastRunRecap,
  listModelRows,
  listModels,
  pickModelInteractive,
  registerIoHandlers,
} from "./tui-interactive.js";
import { createTerminalIo } from "./tui-io.js";
import { buildSlashSystem } from "./tui-slash.js";
import {
  addUserInput,
  applyEvent,
  applyOutcome,
  hydrateTranscript,
  initialViewState,
  settleSteeredMessages,
  type TuiViewState,
} from "./view-state.js";

/** TUI mode: oma's standalone interactive surface. One process = N
 *  consecutive Runs over ONE session file; each Run is its own Runtime
 *  (one Runtime = one Run invariant preserved). Enter submits; while a Run
 *  is live, Enter STEERS the message into the loop immediately (pi's
 *  streamingBehavior:"steer") and a steer rejected because the loop is
 *  settling falls back to a queue that auto-drains as the next Run's input
 *  (pi's AgentBusyError -> followUp) — no message is ever dropped. Esc
 *  aborts; ctrl+t toggles thinking; ctrl+o toggles tool detail; /exit
 *  quits.
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
  /** Prefill the editor with this text on boot (`oma "prompt"`). The user
   *  hits Enter to send it like any other input. */
  initialPrompt?: string;
  /** --tools filter (CLI): applied to the final tool table. */
  toolFilter?: ToolFilter;
}

/** View/abort commands from the terminal (Esc abort, ctrl+t, ctrl+o, ctrl+p). */
export type TuiCommand = "toggleThinking" | "toggleToolDetail" | "abort" | "pickModel" | "forkTree";

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
  /** Subscriber for slash commands submitted while a run is live; the
   *  session loop executes them instead of steering the text (pi's
   *  LiveCommandController). */
  onLiveCommand?(handler: ((text: string) => void) | null): void;
  /** Subscriber for view/abort commands (Esc, ctrl+t, ctrl+o). */
  onCommand?(handler: ((cmd: TuiCommand) => void) | null): void;
  /** Register the slash-command list for editor autocomplete. */
  setSlashCommands?(commands: readonly SlashCommand[]): void;
  /** Interactive session picker overlay; resolves the chosen session id,
   *  or null when cancelled. Absent = caller falls back to a text list. */
  pickSession?(
    sessions: ReadonlyArray<{
      id: string;
      title?: string;
      preview: string;
      modifiedAt: number;
      workspace?: string;
      forkOf?: string;
    }>,
  ): Promise<string | null>;
  /** Interactive model picker overlay (ctrl+p); resolves the chosen
   *  canonical `<provider>/<model>` id, or null when cancelled. */
  pickModel?(
    models: ReadonlyArray<{ id: string; label: string; description?: string }>,
  ): Promise<string | null>;
  /** Interactive approval confirm (HITL); resolves "allow"/"deny", null on
   *  cancel (treated as deny — fail-closed). Absent = deny. */
  confirmApproval?(req: { toolName: string; reason?: string }): Promise<"allow" | "deny" | null>;
  /** Interactive ask_question form (HITL); resolves answers or null on
   *  cancel/unsupported question kind (fail-closed). */
  askQuestions?(input: AskQuestionInput): Promise<AskQuestionResult | null>;
  /** Interactive fork-point picker (pi's user-message selector): lists the
   *  session's user messages; resolves the chosen 1-based ordinal, or null
   *  when cancelled. Absent = caller falls back to /fork <n>. */
  pickForkPoint?(points: ReadonlyArray<{ ordinal: number; text: string }>): Promise<number | null>;
  /** Interactive branch-tree fork picker: lists the session's parentId-
   *  chained message nodes; resolves the chosen node id, or null when
   *  cancelled. Absent = caller falls back to the /fork text path. */
  pickBranchTree?(nodes: ReadonlyArray<SessionBranchNode>): Promise<string | null>;
  /** Interactive settings editor; resolves the updated settings or null on
   *  cancel. Absent = caller falls back to text status. */
  editSettings?(settings: ProjectSettings): Promise<ProjectSettings | null>;
  /** Update the fixed header's model/session line. `context` is sticky:
   *  once set it stays until the next value arrives. */
  setHeader?(info: { model?: string; sessionId?: string; title?: string; context?: string }): void;
  /** M-bash: interactive pty console overlay (TUI only). Resolves when
   *  the command exits or the user kills it (Esc). */
  runPtyConsole?(
    command: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ exitCode: number | null; tail: string; killed: boolean }>;
  /** Prefill the editor text (used for `oma "<prompt>"`). */
  setInputText?(text: string): void;
  /** True while the terminal window holds focus (CSI 1004 reporting).
   *  Absent = always considered focused. */
  isFocused?(): boolean;
  /** Subscriber for terminal focus transitions (CSI 1004 reporting). */
  onFocus?(handler: ((focused: boolean) => void) | null): void;
  /** Best-effort completion ping (BEL). Absent = silent. */
  notify?(): void;
  /** Stop the terminal (restore modes). */
  close(): void;
}

/** A saved project model is used only when it still resolves in the catalog;
 *  a stale provider/model must not brick TUI startup. */
async function savedModelIsAvailable(
  modelRuntime: ModelRuntime,
  modelId: string,
): Promise<boolean> {
  try {
    const catalog = await modelRuntime.getCatalog();
    return catalog.models.some(
      (m) => `${m.providerId}/${m.modelId}` === modelId && m.available !== false,
    );
  } catch {
    return false;
  }
}

/** The full interactive session loop, driver-agnostic. */
export async function runTuiSession(opts: TuiModeOptions, io: TuiIo): Promise<number> {
  let session = resolveSession(opts.sessionId);
  const state = initialViewState();
  hydrateTranscript(state, session.messages);
  let modelId: string | undefined;
  if (opts.model) {
    modelId = opts.model;
  } else {
    const saved = loadProjectSettings(opts.workspaceRoot).model;
    modelId = saved && (await savedModelIsAvailable(opts.modelRuntime, saved)) ? saved : undefined;
  }
  let liveRuntime: OmaRuntime | null = null;
  let sessionTitle: string | undefined;
  let quitting = false;
  let exitArmed = false;
  /** Estimated context tokens after the last run: drives the picker's
   *  over-context warning (pi grays out models smaller than the session). */
  let lastContextTokens: number | undefined;
  /** Recap shown when the terminal regains focus after an unfocused run. */
  let pendingFocusRecap: string | undefined;
  /** Prompt queued by a command (skill invocations): submitted as the next
   *  normal run. */
  let pendingPrompt: string | undefined;
  /** Workflow script queued by /workflow: injected into the next run input. */
  let pendingWorkflowScript: string | undefined;

  function pushStatus(lines: string | readonly string[], replacePrefix?: string): void {
    const items = (typeof lines === "string" ? [lines] : lines).map((text) => ({
      kind: "status" as const,
      text,
      streaming: false,
    }));
    if (replacePrefix) {
      for (let i = state.runs.length - 1; i >= 0; i--) {
        const first = state.runs[i]!.items[0];
        if (first?.kind === "status" && first.text.startsWith(replacePrefix)) {
          state.runs[i] = { items, running: false };
          return;
        }
      }
    }
    state.runs.push({ items, running: false });
  }

  /** Compact recap text for the most recent run: last assistant message
   *  first line, falling back to the auto title. */

  io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
  // `oma "<prompt>"` opens the TUI with the prompt prefilled in the editor.
  if (opts.initialPrompt) io.setInputText?.(opts.initialPrompt);

  const ctx: TuiSessionContext = {
    state,
    io,
    opts,
    get session() {
      return session;
    },
    set session(value) {
      session = value;
    },
    get sessionTitle() {
      return sessionTitle;
    },
    set sessionTitle(value) {
      sessionTitle = value;
    },
    get modelId() {
      return modelId;
    },
    set modelId(value) {
      modelId = value;
    },
    get quitting() {
      return quitting;
    },
    set quitting(value) {
      quitting = value;
    },
    get exitArmed() {
      return exitArmed;
    },
    set exitArmed(value) {
      exitArmed = value;
    },
    get pendingPrompt() {
      return pendingPrompt;
    },
    set pendingPrompt(value) {
      pendingPrompt = value;
    },
    get pendingWorkflowScript() {
      return pendingWorkflowScript;
    },
    set pendingWorkflowScript(value) {
      pendingWorkflowScript = value;
    },
    get liveRuntime() {
      return liveRuntime;
    },
    set liveRuntime(value) {
      liveRuntime = value;
    },
    get lastContextTokens() {
      return lastContextTokens;
    },
    set lastContextTokens(value) {
      lastContextTokens = value;
    },
    get pendingFocusRecap() {
      return pendingFocusRecap;
    },
    set pendingFocusRecap(value) {
      pendingFocusRecap = value;
    },
    pushStatus,
    listModels: () => listModels(ctx),
    listModelRows: () => listModelRows(ctx),
    listSessions,
    pickModelInteractive: () => pickModelInteractive(ctx),
    forkTreeInteractive: () => forkTreeInteractive(ctx),
  };
  const commands = buildCommands(ctx);

  const { slashCommands, runCommandText } = buildSlashSystem(ctx, commands);
  ctx.runCommandText = runCommandText;
  io.setSlashCommands?.(slashCommands);
  registerIoHandlers(ctx);

  io.onLiveCommand?.((text) => {
    void runCommandText(text).then(() => io.render(state));
  });

  /** Steers rejected while the loop was settling; drained as the next
   *  Run's prompt when the current Run ends (pi's followUp fallback). */
  const pendingFollowUps: string[] = [];

  for (;;) {
    io.render(state);
    // Steers that arrived while the previous loop was settling are drained
    // here as the next Run's prompt (already echoed as » items — no re-echo).
    let text: string;
    let fromFollowUp = false;
    if (pendingFollowUps.length > 0) {
      const drained = pendingFollowUps.splice(0);
      text = drained.join("\n\n");
      fromFollowUp = true;
      // Settle the queued » echoes in place — no re-echo (pi moves queued
      // messages into the chat when they are delivered).
      settleSteeredMessages(state, drained);
    } else {
      const input = await io.waitForInput();
      if (input === null) return 0;
      text = input.trim();
      if (!text) continue;
    }

    if (text.startsWith("/")) {
      await runCommandText(text);
      if (quitting) return 0;
      // A command queued a prompt (skill invocation, workflow): submit it as
      // the next run instead of returning to the editor.
      if (pendingPrompt === undefined) continue;
      text = pendingPrompt;
      pendingPrompt = undefined;
    }

    if (!fromFollowUp) addUserInput(state, text);

    const built = await buildCliRunInput({
      prompt: text,
      workspaceRoot: opts.workspaceRoot,
      modelRuntime: opts.modelRuntime,
      modelId,
    });
    modelId = built.run.model.modelId;
    // /workflow queued a script: this run executes the vm workflow instead
    // of a conversational loop (create-runtime branches on input.workflow).
    let runInput: BackendRunInput<"oma"> = built;
    if (pendingWorkflowScript !== undefined) {
      runInput = { ...built, workflow: { script: pendingWorkflowScript } };
      pendingWorkflowScript = undefined;
    }
    const pluginRt = await assemblePluginRuntime(opts.workspaceRoot, "tui");
    for (const w of pluginRt.warnings) pushStatus(`[plugin] ${w}`);
    const runtime = await createOmaRuntime({
      runId: `tui-${randomUUID()}`,
      modelId: built.run.model.modelId,
      workspaceRoot: opts.workspaceRoot,
      workspaceAccess: "read_write",
      modelRuntime: opts.modelRuntime,
      skillRoots: built.run.skillRoots ?? [],
      gateWorkspaceMcp: true,
      // M-bash: pty:true bash calls open the interactive console overlay.
      bashPtyConsole: (command, cwd, env) => io.runPtyConsole!(command, cwd, env),
      // HITL: interactive approval overlay; absent picker or cancel = deny.
      approvalHandler: async (req) => {
        const verdict = await io.confirmApproval?.({
          toolName: req.toolName,
          ...(req.reason ? { reason: req.reason } : {}),
        });
        return verdict === "allow"
          ? { decision: "allow" }
          : { decision: "deny", reason: "user denied" };
      },
      // HITL ask_question: interactive overlay; absent/cancel = null (tool
      // fails closed with "no answer").
      ...(io.askQuestions ? { askHandler: io.askQuestions } : {}),
      ...(pluginRt.plugins.length || pluginRt.mcpServers.length
        ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
        : {}),
      ...(built.run.permissionMode ? { permissionMode: built.run.permissionMode } : {}),
      ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
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
      // Real-time session persistence (pi appendMessage): every
      // conversational persist (user prompt, steer, assistant, tool result)
      // lands in the session file immediately, so even a killed/failed
      // process leaves its context for the next turn.
      onPersistMessages: (messages) => {
        appendSessionMessages(session.sessionId, opts.workspaceRoot, messages, session.dir);
        // The session file is wire-loose; the in-memory transcript keeps the
        // same loose shape so it round-trips into sessionTranscript verbatim.
        session.messages = [
          ...session.messages,
          ...messages.map((m) => ({ ...m }) as Record<string, unknown>),
        ];
      },
    });
    io.setBusy?.(true);
    liveRuntime = runtime;

    let outcome: BackendRunOutcome;
    try {
      // Steer: a submit while the run is live injects immediately (pi's
      // streamingBehavior:"steer" — the loop buffers to a safe boundary).
      // A steer rejected because the loop is settling falls back to the
      // follow-up queue and is delivered as the next Run's input — the
      // message is never dropped (pi's AgentBusyError -> followUp).
      const steerHandler = (text: string): void => {
        addUserInput(state, text, true);
        io.render(state);
        runtime
          .steer({
            inputId: `steer-${randomUUID()}`,
            message: { role: "user", text },
          })
          .catch(() => {
            pendingFollowUps.push(text);
            pushStatus("queued: run is settling — sends when it ends");
            io.render(state);
          });
      };
      io.onLiveInput?.(steerHandler);
      const segment = await runtime.run(runInput);
      outcome = await segment.outcome;
      io.onLiveInput?.(null);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      io.onLiveInput?.(null);
    }
    liveRuntime = null;

    applyOutcome(state, outcome);
    io.setBusy?.(false);
    // Long runs often outlast the user's attention: ping when the terminal
    // lost focus so switching back is prompted (pi's desktop-notify analog).
    if (io.isFocused?.() === false) {
      pendingFocusRecap = lastRunRecap(ctx);
      pushStatus("run finished — switch back for recap");
      io.notify?.();
    }

    // Messages were persisted in real time (onPersistMessages); only the
    // end-of-run artifacts (compaction summaries, auto title) remain.
    await persistSessionTurn({
      sessionId: session.sessionId,
      cwd: opts.workspaceRoot,
      runtime,
      dir: session.dir,
      ...(outcome.status === "completed" ? { title: outcome.title } : {}),
    });
    if (outcome.status === "completed") {
      sessionTitle = outcome.title ?? sessionTitle;
      io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
    }
    // Compaction happened mid-run: surface what was folded away so the
    // user knows the context was summarized.
    for (const summary of await runtime.compactions()) {
      pushStatus(`compacted: ${summary.slice(0, 160)}${summary.length > 160 ? "…" : ""}`);
    }
    // omp AutoLearn-style indicator: the run's background memory-learn pass
    // shows on the transcript without blocking the editor (the promise
    // resolves even after close()).
    const learning = runtime.memoryLearning();
    if (learning) {
      pushStatus("memory: learning…");
      io.render(state);
      void learning.then((res) => {
        pushStatus(
          res.freshFacts > 0
            ? `memory: learned ${res.freshFacts} fact${res.freshFacts === 1 ? "" : "s"}`
            : res.ran
              ? "memory: nothing new to learn"
              : "memory: skipped",
          "memory: ",
        );
        io.render(state);
      });
    }
    // Context footprint of the settled branch under the run model's window
    // (pi's context-usage display); read BEFORE close() like compactions().
    const usage = await runtime.contextUsage().catch(() => undefined);
    if (usage) lastContextTokens = usage.estimatedTokens;
    const usageParts: string[] = [];
    if (outcome.usage) {
      if (outcome.usage.inputTokens) usageParts.push(`↑${outcome.usage.inputTokens}`);
      if (outcome.usage.outputTokens) usageParts.push(`↓${outcome.usage.outputTokens}`);
      if (outcome.usage.cacheReadTokens) usageParts.push(`cache ${outcome.usage.cacheReadTokens}`);
    }
    if ((usage && usage.limit > 0) || usageParts.length > 0) {
      const ctx =
        usage && usage.limit > 0
          ? `ctx ${formatTokens(usage.estimatedTokens)}/${formatTokens(usage.limit)}`
          : "";
      const pct =
        usage && usage.limit > 0
          ? Math.min(100, Math.round((usage.estimatedTokens / usage.limit) * 100))
          : 0;
      const context = [ctx, ...(usageParts.length > 0 ? [usageParts.join(" ")] : [])]
        .filter(Boolean)
        .join(" · ");
      io.setHeader?.({
        model: modelId,
        sessionId: session.sessionId,
        title: sessionTitle,
        context: pct > 0 ? `${context} · ${pct}%` : context,
      });
    }
    await runtime.close().catch(() => {});
    // /exit (or a second ctrl+c path) may have run via the live-command
    // channel while the Run was live — honor it now that the Run settled.
    if (quitting) return 0;
  }
}

/** CLI entry: run the interactive session over the real terminal. */
export async function runTuiMode(opts: TuiModeOptions): Promise<number> {
  const io = createTerminalIo(new ProcessTerminal(), opts.workspaceRoot);
  try {
    return await runTuiSession(opts, io);
  } finally {
    io.close();
  }
}

export { formatModelMeta } from "./tui-format.js";
export { createTerminalIo } from "./tui-io.js";

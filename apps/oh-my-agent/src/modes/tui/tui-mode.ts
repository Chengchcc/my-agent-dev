import { randomUUID } from "node:crypto";
import type { OmaLoopEvent } from "@chengchenccc/agent";
import type { BackendRunInput, BackendRunOutcome } from "@chengchenccc/agent-backend";
import type { ModelRuntime } from "@chengchenccc/ai";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type SlashCommand,
  type Terminal,
  Text,
  TUI,
} from "@chengchenccc/tui";
import { buildCliRunInput } from "../../cli/initial-input.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/create-runtime.js";
import {
  appendSessionMessages,
  listAllSessions,
  listSessions,
  sessionDirFor,
} from "../../core/session-file.js";
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
 *  while a Run is live steers it; Esc aborts the live Run; ctrl+t toggles
 *  thinking blocks; ctrl+o toggles tool detail; /exit quits.
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

/** View/abort commands from the terminal (Esc abort, ctrl+t, ctrl+o). */
export type TuiCommand = "toggleThinking" | "toggleToolDetail" | "abort";

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
    }>,
  ): Promise<string | null>;
  /** Stop the terminal (restore modes). */
  close(): void;
}

/** Tool display caps. Collapsed view: args are compact one-line previews,
 *  results summarized to their first line + char count so a huge bash
 *  stdout cannot flood the transcript. Expanded (ctrl+o): pretty JSON up
 *  to MAX_TOOL_DETAIL chars. */
const MAX_TOOL_ARGS = 200;
const MAX_TOOL_DETAIL = 8_000;

/** Compact single-line JSON, truncated with an ellipsis marker. */
function compactJson(value: unknown, max: number): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** Multi-line pretty JSON, truncated at MAX_TOOL_DETAIL with an ellipsis. */
function prettyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.length > MAX_TOOL_DETAIL ? `${json.slice(0, MAX_TOOL_DETAIL)}…` : json;
}

/** Collapsed tool-result summary: the full compact JSON when it is short,
 *  otherwise the first meaningful line + remaining char count. */
function summarizeResult(result: Readonly<Record<string, unknown>>): string {
  const json = JSON.stringify(result) ?? "";
  if (json.length <= MAX_TOOL_ARGS) return json;
  let firstLine = json;
  for (const value of Object.values(result)) {
    if (typeof value === "string" && value.trim()) {
      firstLine = value.trim().split("\n", 1)[0] ?? value;
      break;
    }
  }
  if (firstLine.length > MAX_TOOL_ARGS) {
    firstLine = `${firstLine.slice(0, MAX_TOOL_ARGS)}…`;
  }
  return `${firstLine} (+${json.length - firstLine.length} chars, ctrl+o)`;
}

/** Pi-style collapsed arg summaries: a human sentence per common tool
 *  (bash's `$ cmd`, read's `path:a-b`), falling back to compact JSON. */
const TOOL_ARG_SUMMARIES: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (i) => {
    const command = typeof i.command === "string" ? i.command : "";
    const timeout =
      typeof i.timeout === "number" ? ` (timeout ${Math.round(i.timeout / 1000)}s)` : "";
    return `$ ${command}${timeout}`;
  },
  read: (i) => {
    const path = typeof i.path === "string" ? i.path : "";
    if (typeof i.offset === "number" && typeof i.limit === "number") {
      return `${path}:${i.offset}-${i.offset + i.limit - 1}`;
    }
    return path;
  },
  write: (i) => (typeof i.path === "string" ? i.path : ""),
  edit: (i) => (typeof i.path === "string" ? i.path : ""),
  grep: (i) => {
    const pattern = typeof i.pattern === "string" ? i.pattern : "";
    const path = typeof i.path === "string" ? ` ${i.path}` : "";
    return `${pattern}${path}`;
  },
  glob: (i) => (typeof i.pattern === "string" ? i.pattern : ""),
};

function summarizeToolArgs(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const summarize = TOOL_ARG_SUMMARIES[toolName];
  if (summarize) {
    const summary = summarize(input);
    if (summary.trim()) return summary;
  }
  return compactJson(input, MAX_TOOL_ARGS);
}
const EDITOR_THEME: EditorTheme = {
  borderColor: (s) => s,
  selectList: {
    selectedPrefix: (s) => `\u001b[36m${s}\u001b[0m`,
    selectedText: (s) => `\u001b[1m${s}\u001b[0m`,
    description: (s) => `\u001b[2m${s}\u001b[0m`,
    scrollInfo: (s) => `\u001b[2m${s}\u001b[0m`,
    noMatch: (s) => `\u001b[2m${s}\u001b[0m`,
  },
};

/** Compact relative age for the session picker's label column. */
function relativeTime(modifiedAt: number): string {
  const minutes = Math.floor((Date.now() - modifiedAt) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** Overlay root for the session picker: renders title + list and routes
 *  key input to the list (a plain Container has no handleInput). */
class PickerOverlay extends Container {
  constructor(
    title: Text,
    private readonly list: SelectList,
  ) {
    super();
    this.addChild(title);
    this.addChild(list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** The full interactive session loop, driver-agnostic. */
export async function runTuiSession(opts: TuiModeOptions, io: TuiIo): Promise<number> {
  let session = resolveSession(opts.sessionId);
  const state = initialViewState();
  let modelId = opts.model;
  let liveRuntime: OmaRuntime | null = null;
  let sessionTitle: string | undefined;
  let quitting = false;

  function pushStatus(lines: string | readonly string[]): void {
    const items = (typeof lines === "string" ? [lines] : lines).map((text) => ({
      kind: "status" as const,
      text,
      streaming: false,
    }));
    state.runs.push({ items, running: false });
  }

  // One command handler for the whole session: toggles work between runs,
  // abort only while a run is live.
  io.onCommand?.((cmd) => {
    if (cmd === "toggleThinking") {
      state.showThinking = !state.showThinking;
    } else if (cmd === "toggleToolDetail") {
      state.showToolDetail = !state.showToolDetail;
    } else if (liveRuntime) {
      void liveRuntime.stop().catch(() => {});
    }
    io.render(state);
  });

  async function listModels(): Promise<string[]> {
    const catalog = await opts.modelRuntime.getCatalog();
    return catalog.models.map((m) => `${m.providerId}/${m.modelId}`);
  }

  const commands: ReadonlyArray<{
    name: string;
    description: string;
    argumentHint?: string;
    run: (args: string) => void | Promise<void>;
  }> = [
    {
      name: "help",
      description: "list slash commands",
      run: () => {
        pushStatus(
          commands.map(
            (c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`,
          ),
        );
      },
    },
    {
      name: "exit",
      description: "quit the session",
      run: () => {
        quitting = true;
      },
    },
    {
      name: "quit",
      description: "alias of /exit",
      run: () => {
        quitting = true;
      },
    },
    {
      name: "session",
      description: "show the current session id and title",
      run: () => {
        pushStatus(`session: ${session.sessionId}${sessionTitle ? ` — ${sessionTitle}` : ""}`);
      },
    },
    {
      name: "model",
      description: "show or switch the model",
      argumentHint: "<provider/model>",
      run: async (args) => {
        if (!args) {
          const models = await listModels();
          const current = modelId ?? models[0] ?? "(none)";
          pushStatus([
            `current model: ${current}`,
            ...models.map((m) => `  ${m === current ? "*" : " "} ${m}`),
          ]);
          return;
        }
        const models = await listModels();
        if (!models.includes(args)) {
          pushStatus(`unknown model: ${args} (see /model for the list)`);
          return;
        }
        modelId = args;
        pushStatus(`model: ${modelId}`);
      },
    },
    {
      name: "resume",
      description: "list/resume sessions (all = every workspace)",
      argumentHint: "<session>",
      run: async (args) => {
        // "all" = cross-workspace listing (pi's session selector "all"
        // scope); any other arg is an id/prefix within this workspace.
        const all = args === "all";
        const sessions = all ? listAllSessions() : listSessions();
        if (sessions.length === 0) {
          pushStatus(all ? "no sessions in any workspace" : "no saved sessions");
          return;
        }
        if (!args || all) {
          // Interactive overlay when the io supports it; text list otherwise.
          if (io.pickSession) {
            const picked = await io.pickSession(sessions.slice(0, 20));
            if (!picked) {
              pushStatus("resume cancelled");
              return;
            }
            const summary = sessions.find((s) => s.id === picked);
            const dir = summary?.workspace ? sessionDirFor(summary.workspace) : undefined;
            session = resolveSession(picked, dir);
            sessionTitle = summary?.title;
            state.runs.length = 0;
            pushStatus(
              `resumed session: ${session.sessionId} (${session.messages.length} messages)`,
            );
            return;
          }
          pushStatus(
            sessions.slice(0, 20).map((s) => {
              const when = new Date(s.modifiedAt).toISOString().slice(0, 16).replace("T", " ");
              const workspace = s.workspace ? ` [${s.workspace}]` : "";
              return `${when}  ${s.id}${workspace}  ${s.title ?? s.preview}`;
            }),
          );
          return;
        }
        const matches = sessions.filter((s) => s.id.startsWith(args));
        if (matches.length === 0) {
          pushStatus(`no session matches: ${args} (see /resume for the list)`);
          return;
        }
        if (matches.length > 1) {
          pushStatus(matches.map((s) => `${s.id}  ${s.title ?? s.preview}`));
          return;
        }
        const dir = matches[0]!.workspace ? sessionDirFor(matches[0]!.workspace) : undefined;
        session = resolveSession(matches[0]!.id, dir);
        sessionTitle = matches[0]!.title;
        state.runs.length = 0;
        pushStatus(`resumed session: ${session.sessionId} (${session.messages.length} messages)`);
      },
    },
    {
      name: "new",
      description: "start a fresh session (clears the transcript)",
      run: () => {
        session = resolveSession();
        sessionTitle = undefined;
        state.runs.length = 0;
        pushStatus(`new session: ${session.sessionId}`);
      },
    },
    {
      name: "clear",
      description: "clear the transcript view (keeps the session)",
      run: () => {
        state.runs.length = 0;
      },
    },
    {
      name: "thinking",
      description: "toggle thinking blocks (ctrl+t)",
      run: () => {
        state.showThinking = !state.showThinking;
        pushStatus(`thinking ${state.showThinking ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "tools",
      description: "toggle tool detail (ctrl+o)",
      run: () => {
        state.showToolDetail = !state.showToolDetail;
        pushStatus(`tool detail ${state.showToolDetail ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "abort",
      description: "abort the live run (esc)",
      run: () => {
        if (liveRuntime) void liveRuntime.stop().catch(() => {});
        else pushStatus("no live run");
      },
    },
  ];

  // Autocomplete: the editor already triggers on "/" — hand it the table.
  const slashCommands: SlashCommand[] = commands.map((c) => {
    const command: SlashCommand = { name: c.name, description: c.description };
    if (c.argumentHint) command.argumentHint = c.argumentHint;
    if (c.name === "model") {
      command.getArgumentCompletions = async (prefix: string) => {
        const models = await listModels();
        return models.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m }));
      };
    }
    if (c.name === "resume") {
      command.getArgumentCompletions = (prefix: string) =>
        listSessions()
          .filter((s) => s.id.startsWith(prefix))
          .slice(0, 20)
          .map((s) => ({
            value: s.id,
            label: s.id,
            description: s.title ?? (s.preview || undefined),
          }));
    }
    return command;
  });
  io.setSlashCommands?.(slashCommands);

  for (;;) {
    io.render(state);
    const input = await io.waitForInput();
    if (input === null) return 0;
    const text = input.trim();
    if (!text) continue;

    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      const name = space === -1 ? text.slice(1) : text.slice(1, space);
      const args = space === -1 ? "" : text.slice(space + 1).trim();
      const command = commands.find((c) => c.name === name);
      if (!command) {
        pushStatus(`unknown command /${name} — try /help`);
        continue;
      }
      await command.run(args);
      if (quitting) return 0;
      continue;
    }

    addUserInput(state, text);

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
    liveRuntime = null;

    applyOutcome(state, outcome);
    io.setBusy?.(false);

    // Messages were persisted in real time (onPersistMessages); only the
    // end-of-run artifacts (compaction summaries, auto title) remain.
    await persistSessionTurn({
      sessionId: session.sessionId,
      cwd: opts.workspaceRoot,
      runtime,
      dir: session.dir,
      ...(outcome.status === "completed" ? { title: outcome.title } : {}),
    });
    if (outcome.status === "completed") sessionTitle = outcome.title ?? sessionTitle;
    await runtime.close().catch(() => {});
  }
}

/** Production TuiIo over the real terminal. The optional terminal override
 *  is the test seam: e2e tests inject a VirtualTerminal (xterm headless). */
export function createTerminalIo(
  terminal: Terminal = new ProcessTerminal(),
  workspaceRoot: string = process.cwd(),
): TuiIo {
  const tui = new TUI(terminal);
  const transcript = new Container();
  const statusContainer = new Container();
  const editor = new Editor(tui, EDITOR_THEME);
  let pending: ((value: string | null) => void) | null = null;
  let busy = false;
  let liveHandler: ((text: string) => void) | null = null;
  let commandHandler: ((cmd: TuiCommand) => void) | null = null;
  let loader: Loader | null = null;

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

  // Esc/ctrl+t/ctrl+o are intercepted before the editor sees them. Esc
  // aborts a live run (pi's app.interrupt); ctrl+t and ctrl+o toggle the
  // thinking-block and tool-detail views globally.
  tui.addInputListener((data) => {
    if (matchesKey(data, "escape") && busy) {
      if (commandHandler) commandHandler("abort");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      if (commandHandler) commandHandler("toggleThinking");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      if (commandHandler) commandHandler("toggleToolDetail");
      return { consume: true };
    }
    return undefined;
  });

  function render(state: TuiViewState): void {
    transcript.clear();
    const lines: string[] = [];
    for (const run of state.runs) {
      for (const item of run.items) lines.push(...renderItem(item, state));
    }
    for (const line of lines) transcript.addChild(new Text(line, undefined, 1));
    tui.requestRender();
  }

  function renderItem(item: TranscriptItem, state: TuiViewState): string[] {
    switch (item.kind) {
      case "user":
        return [`\u001b[36m> ${item.text}\u001b[0m`];
      case "assistant":
        return item.text ? [item.text] : [];
      case "thinking":
        return renderThinking(item, state.showThinking);
      case "tool":
        return renderTool(item, state.showToolDetail);
      case "status":
        return [`\u001b[2m  [${item.text}]\u001b[0m`];
      case "error":
        return [`\u001b[31m  error: ${item.text}\u001b[0m`];
    }
  }

  function renderThinking(item: TranscriptItem, expanded: boolean): string[] {
    if (!item.text) return [];
    const firstLine = item.text.split("\n", 1)[0] ?? "";
    const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
    if (!expanded) {
      // Collapsed: one dim line + hint that more exists (ctrl+t expands).
      if (item.text.length === firstLine.length) return [dim(`  ~ ${firstLine}`)];
      return [dim(`  ~ ${firstLine} … (ctrl+t)`)];
    }
    return item.text.split("\n").map((line) => dim(`  ~ ${line}`));
  }

  function renderTool(item: TranscriptItem, expanded: boolean): string[] {
    const lines: string[] = [];
    // Status marker (pi's pending/success/error bg tint, as fg color):
    // yellow ● while running, green ✔ done, red ✘ on error results.
    const toolName = item.text.replace(/…$/, "");
    const failed =
      item.result !== undefined &&
      (item.result.isError === true || item.result.error !== undefined);
    const mark = item.streaming ? "\u25cf" : failed ? "\u2718" : "\u2714";
    const color = item.streaming ? "33" : failed ? "31" : "32";
    const boldName = `\u001b[1m${toolName}\u001b[22m`;
    if (expanded) {
      // Full pretty JSON for args and result, dimmed under the header.
      lines.push(`\u001b[${color}m  ${mark} \u001b[0m${boldName}`);
      if (item.input !== undefined) {
        for (const line of prettyJson(item.input).split("\n")) {
          lines.push(`\u001b[2m    ${line}\u001b[0m`);
        }
      }
      if (item.result !== undefined) {
        for (const line of prettyJson(item.result).split("\n")) {
          lines.push(`\u001b[2m    ${line}\u001b[0m`);
        }
      }
      return lines;
    }
    // Collapsed: pi-style arg summary sentence (e.g. `$ echo hi`,
    // `read src/foo.ts:40-80`), not raw JSON; result as first line + count.
    const args = item.input !== undefined ? ` ${summarizeToolArgs(toolName, item.input)}` : "";
    lines.push(`\u001b[${color}m  ${mark} \u001b[0m${boldName}\u001b[2m${args}\u001b[0m`);
    if (item.result !== undefined) {
      lines.push(`\u001b[2m    ${summarizeResult(item.result)}\u001b[0m`);
    }
    return lines;
  }

  tui.addChild(transcript);
  tui.addChild(statusContainer);
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
      // The animated status line: a braille spinner + "working" while a
      // run is live, removed when it settles. Loader drives its own timer
      // and calls requestRender on every frame.
      if (next) {
        statusContainer.clear();
        loader = new Loader(
          tui,
          (s) => `\u001b[36m${s}\u001b[0m`,
          (s) => `\u001b[2m${s}\u001b[0m`,
          "working… (esc to abort)",
        );
        loader.start();
        statusContainer.addChild(loader);
      } else {
        if (loader) {
          loader.stop();
          loader = null;
        }
        statusContainer.clear();
      }
      tui.requestRender();
    },
    onLiveInput(handler) {
      liveHandler = handler;
    },
    onCommand(handler) {
      commandHandler = handler;
    },
    setSlashCommands(commands) {
      // Registers slash-command autocomplete; also enables @-file completion
      // over the workspace as a side effect of the combined provider.
      editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider([...commands], workspaceRoot),
      );
    },
    pickSession(sessions) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const items = sessions.map((s) => {
        const base = s.title ?? (s.preview || s.id.slice(0, 8));
        const workspace = s.workspace ? ` [${s.workspace}]` : "";
        return {
          value: s.id,
          label: relativeTime(s.modifiedAt),
          description: `${base}${workspace}`,
        };
      });
      const list = new SelectList(items, 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 6,
        maxPrimaryColumnWidth: 8,
      });
      const overlayBox = new PickerOverlay(
        new Text("  resume session — ↑/↓ select, enter resume, esc cancel", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value);
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    close() {
      if (loader) loader.stop();
      tui.stop();
    },
  };
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

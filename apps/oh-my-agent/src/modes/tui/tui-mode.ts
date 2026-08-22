import { randomUUID } from "node:crypto";
import type { OmaLoopEvent } from "@chengchenccc/agent";
import type { BackendRunInput, BackendRunOutcome } from "@chengchenccc/agent-backend";
import type { ModelRuntime } from "@chengchenccc/ai";
import {
  CombinedAutocompleteProvider,
  Container,
  type DefaultTextStyle,
  Editor,
  type EditorTheme,
  Input,
  Loader,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  routeSgrMouseInput,
  SelectList,
  type SelectListTheme,
  type SlashCommand,
  type Terminal,
  Text,
  TUI,
} from "@chengchenccc/tui";
import { buildCliRunInput } from "../../cli/initial-input.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/create-runtime.js";
import {
  appendInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "../../core/input-history.js";
import {
  appendSessionMessages,
  deleteSession,
  forkSession,
  listAllSessions,
  listSessions,
  renameSession,
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
}

/** View/abort commands from the terminal (Esc abort, ctrl+t, ctrl+o, ctrl+p). */
export type TuiCommand = "toggleThinking" | "toggleToolDetail" | "abort" | "pickModel";

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
  /** Interactive fork-point picker (pi's user-message selector): lists the
   *  session's user messages; resolves the chosen 1-based ordinal, or null
   *  when cancelled. Absent = caller falls back to /fork <n>. */
  pickForkPoint?(points: ReadonlyArray<{ ordinal: number; text: string }>): Promise<number | null>;
  /** Update the fixed header's model/session line. `context` is sticky:
   *  once set it stays until the next value arrives. */
  setHeader?(info: { model?: string; sessionId?: string; title?: string; context?: string }): void;
  /** Prefill the editor text (used for `oma "<prompt>"`). */
  setInputText?(text: string): void;
  /** True while the terminal window holds focus (CSI 1004 reporting).
   *  Absent = always considered focused. */
  isFocused?(): boolean;
  /** Best-effort completion ping (BEL). Absent = silent. */
  notify?(): void;
  /** Stop the terminal (restore modes). */
  close(): void;
}

/** Tool display caps. Collapsed view: args are compact one-line previews,
 *  results summarized to their first line + char count so a huge bash
 *  stdout cannot flood the transcript. Expanded (ctrl+o): pretty JSON up
 *  to MAX_TOOL_DETAIL chars. */
const MAX_TOOL_ARGS = 200;
const MAX_TOOL_DETAIL = 8_000;
/** Edit-tool diff lines per side in the collapsed tool view. */
const MAX_DIFF_LINES = 6;

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

/** Markdown theme for assistant output: plain readable text with ANSI
 *  emphasis — bold/italic/links/code styled, headings bold, no colors
 *  beyond dim (pi renders through its theme; oma keeps it monochrome+dim
 *  so the cyan user bubble stays the only saturated element). */
const MARKDOWN_THEME: MarkdownTheme = {
  heading: (s) => `\u001b[1m${s}\u001b[0m`,
  link: (s) => `\u001b[4m${s}\u001b[0m`,
  linkUrl: (s) => `\u001b[2m${s}\u001b[0m`,
  code: (s) => `\u001b[36m${s}\u001b[0m`,
  codeBlock: (s) => `\u001b[36m${s}\u001b[0m`,
  codeBlockBorder: (s) => `\u001b[2m${s}\u001b[0m`,
  quote: (s) => `\u001b[2m${s}\u001b[0m`,
  quoteBorder: (s) => `\u001b[2m${s}\u001b[0m`,
  hr: (s) => `\u001b[2m${s}\u001b[0m`,
  listBullet: (s) => `\u001b[36m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  italic: (s) => `\u001b[3m${s}\u001b[0m`,
  strikethrough: (s) => `\u001b[9m${s}\u001b[0m`,
  underline: (s) => `\u001b[4m${s}\u001b[0m`,
};

/** User bubble: markdown text on a deep-blue background tint with cyan
 *  text (pi's UserMessageComponent look). */
const USER_TEXT_STYLE: DefaultTextStyle = {
  color: (s) => `\u001b[36m${s}\u001b[0m`,
  bgColor: (s) => `\u001b[48;5;24m${s}\u001b[0m`,
};

/** Compact token count for the header: 12k / 200k. */
function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
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

/** Overlay for ctrl+r history search (pi's HistorySearchComponent, lazy
 *  form): a query input plus a SelectList rebuilt per keystroke. Navigation
 *  keys go to the list; everything else edits the query. */
class HistorySearchOverlay extends Container {
  private readonly listSlot: Container = new Container();
  private readonly query: Input;
  private list: SelectList;
  private readonly entries: readonly string[];
  private readonly theme: SelectListTheme;

  private readonly selectCb: (value: string) => void;
  private readonly cancelCb: () => void;

  constructor(
    title: Text,
    entries: readonly string[],
    theme: SelectListTheme,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.entries = entries;
    this.theme = theme;
    this.selectCb = onSelect;
    this.cancelCb = onCancel;
    this.query = new Input();
    this.list = this.buildList();
    this.addChild(title);
    this.addChild(this.query);
    this.addChild(this.listSlot);
    this.listSlot.addChild(this.list);
  }

  private buildList(): SelectList {
    const needle = this.query.getValue().trim().toLowerCase();
    const matches = this.entries.filter((e) => e.toLowerCase().includes(needle)).slice(0, 100);
    const items = matches.map((value) => ({
      value,
      label: value.length > 48 ? `${value.slice(0, 48)}...` : value,
    }));
    const list = new SelectList(items, 10, this.theme);
    list.onSelect = (item) => this.selectCb(item.value);
    list.onCancel = () => this.cancelCb();
    return list;
  }

  handleInput(data: string): void {
    const navigates =
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "enter");
    if (navigates) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.list.onCancel?.();
      return;
    }
    this.query.handleInput(data);
    this.listSlot.clear();
    this.list = this.buildList();
    this.listSlot.addChild(this.list);
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
  let exitArmed = false;

  function pushStatus(lines: string | readonly string[]): void {
    const items = (typeof lines === "string" ? [lines] : lines).map((text) => ({
      kind: "status" as const,
      text,
      streaming: false,
    }));
    state.runs.push({ items, running: false });
  }

  io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
  // `oma "<prompt>"` opens the TUI with the prompt prefilled in the editor.
  if (opts.initialPrompt) io.setInputText?.(opts.initialPrompt);

  // One command handler for the whole session: toggles work between runs,
  // abort only while a run is live.
  io.onCommand?.((cmd) => {
    if (cmd === "toggleThinking") {
      state.showThinking = !state.showThinking;
    } else if (cmd === "toggleToolDetail") {
      state.showToolDetail = !state.showToolDetail;
    } else if (cmd === "pickModel") {
      void pickModelInteractive();
    } else if (liveRuntime) {
      void liveRuntime.stop().catch(() => {});
    }
    io.render(state);
  });

  async function listModels(): Promise<string[]> {
    const catalog = await opts.modelRuntime.getCatalog();
    return catalog.models.map((m) => `${m.providerId}/${m.modelId}`);
  }

  /** ctrl+p: interactive model picker overlay. */
  async function pickModelInteractive(): Promise<void> {
    if (!io.pickModel) return;
    const catalog = await opts.modelRuntime.getCatalog();
    const picked = await io.pickModel(
      catalog.models.map((m) => ({
        id: `${m.providerId}/${m.modelId}`,
        label: `${m.providerId}/${m.modelId}`,
        description: m.displayName,
      })),
    );
    if (!picked) return;
    modelId = picked;
    io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
    pushStatus(`model: ${modelId}`);
    io.render(state);
  }

  const commands: ReadonlyArray<{
    name: string;
    description: string;
    argumentHint?: string;
    group: string;
    /** Safe to execute while a run is live (pi's LiveCommandController
     *  scope); session-mutating commands refuse until the run settles. */
    live?: boolean;
    run: (args: string) => void | Promise<void>;
  }> = [
    {
      name: "help",
      description: "list slash commands",
      group: "general",
      live: true,
      run: () => {
        const groups: Array<[string, string[]]> = [];
        for (const c of commands) {
          const entry = `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`;
          const found = groups.find(([name]) => name === c.group);
          if (found) found[1].push(entry);
          else groups.push([c.group, [entry]]);
        }
        pushStatus(
          groups.flatMap(([group, entries]) => [`[${group}]`, ...entries.map((e) => `  ${e}`)]),
        );
      },
    },
    {
      name: "exit",
      description: "quit the session (twice to confirm)",
      group: "general",
      live: true,
      run: () => {
        if (exitArmed) {
          quitting = true;
          return;
        }
        exitArmed = true;
        pushStatus("type /exit again to quit");
      },
    },
    {
      name: "quit",
      description: "alias of /exit",
      group: "general",
      live: true,
      run: () => {
        if (exitArmed) {
          quitting = true;
          return;
        }
        exitArmed = true;
        pushStatus("type /quit again to quit");
      },
    },
    {
      name: "session",
      description: "show the current session id and title",
      group: "session",
      live: true,
      run: () => {
        pushStatus(`session: ${session.sessionId}${sessionTitle ? ` — ${sessionTitle}` : ""}`);
      },
    },
    {
      name: "model",
      description: "show or switch the model",
      argumentHint: "<provider/model>",
      group: "model",
      live: true,
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
        io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
        pushStatus(`model: ${modelId}`);
      },
    },
    {
      name: "resume",
      description: "list/resume sessions (all = every workspace)",
      argumentHint: "<session>",
      group: "session",
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
            io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
            pushStatus(
              `resumed session: ${session.sessionId} (${session.messages.length} messages)`,
            );
            return;
          }
          pushStatus(
            sessions.slice(0, 20).map((s) => {
              const when = new Date(s.modifiedAt).toISOString().slice(0, 16).replace("T", " ");
              const workspace = s.workspace ? ` [${s.workspace}]` : "";
              const fork = s.forkOf ? ` \u2442 ${s.forkOf.slice(0, 8)}` : "";
              return `${when}  ${s.id}${fork}${workspace}  ${s.title ?? s.preview}`;
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
        io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
        pushStatus(`resumed session: ${session.sessionId} (${session.messages.length} messages)`);
      },
    },
    {
      name: "new",
      description: "start a fresh session (clears the transcript)",
      group: "session",
      run: () => {
        session = resolveSession();
        sessionTitle = undefined;
        state.runs.length = 0;
        io.setHeader?.({ model: modelId, sessionId: session.sessionId, title: sessionTitle });
        pushStatus(`new session: ${session.sessionId}`);
      },
    },
    {
      name: "clear",
      description: "clear the transcript view (keeps the session)",
      group: "view",
      run: () => {
        state.runs.length = 0;
      },
    },
    {
      name: "thinking",
      description: "toggle thinking blocks (ctrl+t)",
      group: "view",
      live: true,
      run: () => {
        state.showThinking = !state.showThinking;
        pushStatus(`thinking ${state.showThinking ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "tools",
      description: "toggle tool detail (ctrl+o)",
      group: "view",
      live: true,
      run: () => {
        state.showToolDetail = !state.showToolDetail;
        pushStatus(`tool detail ${state.showToolDetail ? "expanded" : "collapsed"}`);
      },
    },
    {
      name: "abort",
      description: "abort the live run (esc)",
      group: "view",
      live: true,
      run: () => {
        if (liveRuntime) void liveRuntime.stop().catch(() => {});
        else pushStatus("no live run");
      },
    },
    {
      name: "fork",
      description: "fork the session from an earlier user message",
      argumentHint: "<n>",
      group: "session",
      run: async (args) => {
        // Anchors: user-role messages in the live transcript. Compaction
        // summaries carry role user too; they are legitimate fork points.
        const anchors = session.messages
          .filter((m) => (m as { role?: string }).role === "user")
          .map((m) => String((m as { text?: string }).text ?? ""));
        if (anchors.length === 0) {
          pushStatus("no user messages to fork from yet");
          return;
        }
        let ordinal: number | undefined;
        const parsed = Number(args);
        if (args && Number.isInteger(parsed) && parsed >= 1) {
          ordinal = parsed;
        } else if (io.pickForkPoint) {
          const picked = await io.pickForkPoint(
            anchors.map((text, i) => ({
              ordinal: i + 1,
              text: text.replace(/\s+/g, " ").slice(0, 60),
            })),
          );
          if (picked === null) {
            pushStatus("fork cancelled");
            return;
          }
          ordinal = picked;
        } else {
          pushStatus("usage: /fork <n> (n = user message number)");
          return;
        }
        const parentId = session.sessionId;
        const newId = forkSession(parentId, ordinal, session.dir);
        if (newId === null) {
          pushStatus(`cannot fork: no user message #${ordinal}`);
          return;
        }
        session = resolveSession(newId, session.dir);
        sessionTitle = undefined;
        state.runs.length = 0;
        io.setHeader?.({ model: modelId, sessionId: session.sessionId });
        pushStatus(
          `forked ${parentId.slice(0, 8)} @ msg ${ordinal} -> ${newId.slice(0, 8)} ` +
            `(${session.messages.length} messages)`,
        );
      },
    },
    {
      name: "rename",
      description: "rename a session's title",
      argumentHint: "<session> <title>",
      group: "session",
      run: (args) => {
        const space = args.indexOf(" ");
        if (space <= 0) {
          pushStatus("usage: /rename <session-id> <title>");
          return;
        }
        const id = args.slice(0, space).trim();
        const title = args.slice(space + 1).trim();
        if (!title) {
          pushStatus("usage: /rename <session-id> <title>");
          return;
        }
        if (!renameSession(id, title)) pushStatus(`no session: ${id}`);
        else pushStatus(`renamed ${id} → ${title}`);
      },
    },
    {
      name: "delete",
      description: "delete a session file",
      argumentHint: "<session>",
      group: "session",
      run: (args) => {
        if (!args) {
          pushStatus("usage: /delete <session-id>");
          return;
        }
        if (!deleteSession(args)) pushStatus(`no session: ${args}`);
        else pushStatus(`deleted session: ${args}`);
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

  /** Slash-command dispatch shared by the idle loop and live submissions
   *  (pi's LiveCommandController: /commands execute even mid-run instead of
   *  being steered into the model as literal text). */
  async function runCommandText(text: string): Promise<void> {
    const space = text.indexOf(" ");
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    const args = space === -1 ? "" : text.slice(space + 1).trim();
    const command = commands.find((c) => c.name === name);
    if (!command) {
      pushStatus(`unknown command /${name} — try /help`);
      return;
    }
    if (liveRuntime && !command.live) {
      pushStatus(`/${name} is not available while a run is live`);
      return;
    }
    await command.run(args);
  }

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
    if (pendingFollowUps.length > 0) {
      text = pendingFollowUps.splice(0).join("\n\n");
    } else {
      const input = await io.waitForInput();
      if (input === null) return 0;
      text = input.trim();
      if (!text) continue;
    }

    if (text.startsWith("/")) {
      await runCommandText(text);
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
    // Long runs often outlast the user's attention: ping when the terminal
    // lost focus so switching back is prompted (pi's desktop-notify analog).
    if (io.isFocused?.() === false) {
      pushStatus("run finished — terminal was unfocused");
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
    // Context footprint of the settled branch under the run model's window
    // (pi's context-usage display); read BEFORE close() like compactions().
    const usage = await runtime.contextUsage().catch(() => undefined);
    if (usage && usage.limit > 0) {
      const pct = Math.min(100, Math.round((usage.estimatedTokens / usage.limit) * 100));
      io.setHeader?.({
        model: modelId,
        sessionId: session.sessionId,
        title: sessionTitle,
        context: `ctx ${formatTokens(usage.estimatedTokens)}/${formatTokens(usage.limit)} · ${pct}%`,
      });
    }
    await runtime.close().catch(() => {});
    // /exit (or a second ctrl+c path) may have run via the live-command
    // channel while the Run was live — honor it now that the Run settled.
    if (quitting) return 0;
  }
}

/** Production TuiIo over the real terminal. The optional terminal override
 *  is the test seam: e2e tests inject a VirtualTerminal (xterm headless). */
export function createTerminalIo(
  terminal: Terminal = new ProcessTerminal(),
  workspaceRoot: string = process.cwd(),
): TuiIo {
  const tui = new TUI(terminal);
  const headerContainer = new Container();
  const transcript = new Container();
  const statusContainer = new Container();
  const editor = new Editor(tui, EDITOR_THEME);
  let headerInfo = "oma";
  let headerModel = "";
  let headerSession = "";
  let headerTitle = "";
  let headerContext = "";

  // Claude-style fixed header: ASCII wordmark banner + model/session line +
  // separator, all left-aligned. Rendered once and updated via setHeader;
  // transcript scrolls below it independently. Zero padding (paddingX/Y=0):
  // the default paddingY=1 would stack 3 rows per banner line and swallow
  // most of a 30-row terminal.
  function renderHeader(): void {
    headerContainer.clear();
    const lines = [
      "\u001b[36m  ██████╗ ███╗   ███╗ █████╗ \u001b[0m",
      "\u001b[36m ██╔═══██╗████╗ ████║██╔══██╗\u001b[0m",
      "\u001b[36m ██║   ██║██╔████╔██║███████║\u001b[0m",
      "\u001b[36m ██║   ██║██║╚██╔╝██║██╔══██║\u001b[0m",
      "\u001b[36m ╚██████╔╝██║ ╚═╝ ██║██║  ██║\u001b[0m",
      "\u001b[36m  ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝\u001b[0m",
      `\u001b[2m  ${headerInfo}${headerTitle ? ` — ${headerTitle.slice(0, 24)}` : ""}${headerModel ? ` · model ${headerModel}` : ""}${headerSession ? ` · session ${headerSession.slice(0, 8)}` : ""}${headerContext ? ` · ${headerContext}` : ""}\u001b[0m`,
      `\u001b[2m  ${"─".repeat(27)}\u001b[0m`,
    ];
    for (const line of lines) headerContainer.addChild(new Text(line, 0, 0));
  }

  renderHeader();
  let pending: ((value: string | null) => void) | null = null;
  let busy = false;
  let liveHandler: ((text: string) => void) | null = null;
  let liveCommandHandler: ((text: string) => void) | null = null;
  let commandHandler: ((cmd: TuiCommand) => void) | null = null;
  let loader: Loader | null = null;
  let busySince = 0;
  let elapsedTimer: Timer | undefined;
  // Terminal focus (CSI 1004 reporting): a completion ping fires only when
  // the user is looking elsewhere. Default focused — a terminal that never
  // reports focus never pings falsely... actually it never pings at all,
  // which is the safe default.
  let focused = true;

  // Persistent prompt history (pi's HistoryStorage): loaded newest-first,
  // fed to the editor (up/down recall, in-memory cap 100) and appended on
  // every submit — idle prompts AND live steers both pass through
  // editor.onSubmit, the single choke point. Drained follow-ups were already
  // recorded at steer time.
  let historyEntries: readonly string[] = loadInputHistory();
  for (const prompt of historyEntries.slice(0, 100).reverse()) {
    editor.addToHistory(prompt);
  }

  // Idle Ctrl-C quits only on a SECOND press within 2s (a stray press must
  // not kill the session); busy Ctrl-C stays single-press because aborting
  // a run is not destructive. Ctrl-D remains an instant quit.
  let quitArmed = false;
  let quitHint: Text | null = null;
  let quitTimer: Timer | undefined;

  function startElapsedTimer(): void {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!busy) return;
      const seconds = Math.floor((Date.now() - busySince) / 1000);
      loader?.setMessage(`working… (${seconds}s, esc to abort)`);
    }, 1000);
  }

  function dismissQuitHint(): void {
    quitArmed = false;
    clearTimeout(quitTimer);
    if (quitHint) {
      statusContainer.removeChild(quitHint);
      quitHint = null;
    }
  }

  function armQuit(): void {
    quitArmed = true;
    quitHint = new Text("\u001b[33m  press ctrl+c again to quit\u001b[0m", 0, 0);
    statusContainer.addChild(quitHint);
    tui.requestRender();
    quitTimer = setTimeout(() => {
      dismissQuitHint();
      tui.requestRender();
    }, 2_000);
  }

  function recordHistory(prompt: string): void {
    const next = appendInputHistory(historyEntries, prompt);
    if (next === historyEntries) return;
    historyEntries = next;
    saveInputHistory(historyEntries);
    editor.addToHistory(prompt);
  }

  editor.onSubmit = (text) => {
    if (busy) {
      const trimmed = text.trim();
      // Slash commands execute live (pi's LiveCommandController) instead of
      // being steered into the model as literal text; anything else steers
      // immediately — the session loop queues a rejected steer as the next
      // Run's input, so nothing is lost either way.
      if (!trimmed) return;
      if (trimmed.startsWith("/")) {
        if (liveCommandHandler) liveCommandHandler(trimmed);
        return;
      }
      recordHistory(trimmed);
      if (liveHandler) liveHandler(trimmed);
      return;
    }
    dismissQuitHint();
    if (!pending) return;
    const resolve = pending;
    pending = null;
    if (text === "/exit" || text === "/quit") {
      resolve(null);
      return;
    }
    recordHistory(text);
    resolve(text);
  };

  // Esc/ctrl+t/ctrl+o are intercepted before the editor sees them. Esc
  // aborts a live run (pi's app.interrupt); ctrl+t and ctrl+o toggle the
  // thinking-block and tool-detail views globally.
  let scrollOffset = 0;
  let totalLines = 0;
  // Last rendered state: the scroll keys rebuild the window from it (a bare
  // requestRender would repaint the STALE children — the slice happens in
  // render(), so scrolling without re-rendering showed nothing at idle).
  let lastState: TuiViewState | null = null;
  /** Transcript viewport height: terminal rows minus chrome. Header is 8
   *  compact rows (6 banner + info + separator), status 1, the editor its
   *  CURRENT row count (grows with multi-line input — a fixed guess let a
   *  tall editor push the header off-screen), plus the scroll indicator
   *  row while history is viewed. */
  const viewportLines = (): number => {
    const editorRows = Math.max(1, editor.render(tui.terminal.columns).length);
    const indicatorRows = scrollOffset > 0 ? 2 : 0;
    // Every transcript line renders as 2 rows (text + paddingY=1 spacing),
    // so the line budget is half the row budget: header 8 + status 1.
    const rowBudget = tui.terminal.rows - 9 - editorRows - indicatorRows;
    return Math.max(1, Math.floor(rowBudget / 2));
  };

  tui.addInputListener((data) => {
    // Mouse (SGR): the wheel scrolls the transcript window (native
    // scrollback holds no session copy — oma owns all history). All mouse
    // reports are consumed so clicks never reach the editor; plain
    // click-drag text selection needs Shift while the session runs.
    const mouseConsumed = routeSgrMouseInput(data, (event) => {
      if (event.wheel === -1) {
        scrollOffset = Math.min(scrollOffset + 3, Math.max(0, totalLines - viewportLines()));
        if (lastState) render(lastState);
      } else if (event.wheel === 1) {
        scrollOffset = Math.max(0, scrollOffset - 3);
        if (lastState) render(lastState);
      }
      return true;
    });
    if (mouseConsumed) return { consume: true };
    // Focus reporting (CSI 1004): ESC[I focused, ESC[O unfocused.
    if (data === "\x1b[I") {
      focused = true;
      return { consume: true };
    }
    if (data === "\x1b[O") {
      focused = false;
      return { consume: true };
    }
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
    if (matchesKey(data, "ctrl+p")) {
      if (commandHandler) commandHandler("pickModel");
      return { consume: true };
    }
    // ctrl+r: search the persistent prompt history (pi's history search).
    if (matchesKey(data, "ctrl+r")) {
      openHistorySearch();
      return { consume: true };
    }
    // Transcript scroll: PageUp/PageDown step by a viewport, Home jumps to
    // the top, End returns to the latest; ctrl+c aborts the live run when
    // busy and quits when idle.
    if (matchesKey(data, "pageUp")) {
      scrollOffset += viewportLines();
      if (lastState) render(lastState);
      return { consume: true };
    }
    if (matchesKey(data, "pageDown")) {
      scrollOffset = Math.max(0, scrollOffset - viewportLines());
      if (lastState) render(lastState);
      return { consume: true };
    }
    if (matchesKey(data, "home")) {
      scrollOffset = Math.max(0, totalLines - viewportLines());
      if (lastState) render(lastState);
      return { consume: true };
    }
    if (matchesKey(data, "end")) {
      scrollOffset = 0;
      if (lastState) render(lastState);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        if (commandHandler) commandHandler("abort");
      } else if (pending) {
        // Idle: the second press within 2s quits; the first just arms.
        if (quitArmed) {
          dismissQuitHint();
          const resolve = pending;
          pending = null;
          resolve(null);
        } else {
          armQuit();
        }
      }
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  function renderIdleFooter(): void {
    if (busy || statusContainer.children.length > 0) return;
    statusContainer.addChild(
      new Text(
        "  enter send · shift+enter newline · esc abort · ctrl+t thinking · ctrl+o tools · ctrl+p model · /help",
        0,
        0,
      ),
    );
  }
  function render(state: TuiViewState): void {
    lastState = state;
    transcript.clear();
    const lines: string[] = [];
    for (const run of state.runs) {
      for (const item of run.items) lines.push(...renderItem(item, state));
    }
    totalLines = lines.length;
    // Draw the true viewport window [end - viewport, end) where end =
    // total - scrollOffset. Slicing here — instead of stacking every line
    // and letting the TUI clip the buffer bottom — bounds the Text children
    // by the viewport (a long session no longer re-renders thousands of
    // rows per event) and keeps the scroll indicator inside the drawn
    // window where it is actually visible.
    scrollOffset = Math.min(scrollOffset, Math.max(0, lines.length - viewportLines()));
    const viewport = viewportLines();
    const end = lines.length - scrollOffset;
    const start = Math.max(0, end - viewport);
    // Scroll indicator while viewing history: lines hidden above/below and
    // how to return (End).
    if (scrollOffset > 0) {
      transcript.addChild(
        new Text(
          `\u001b[2m  ↑ ${start} lines above · ↓ ${scrollOffset} below — End to return\u001b[0m`,
          undefined,
          1,
        ),
      );
    }
    for (const line of lines.slice(start, end)) transcript.addChild(new Text(line, undefined, 1));
    renderIdleFooter();
    tui.requestRender();
  }
  /** Per-item Markdown components memoized on the item reference: settled
   *  items re-render from the component's width/text cache instead of
   *  re-parsing markdown on every frame; streaming items invalidate via
   *  setText. */
  const markdownCache = new WeakMap<TranscriptItem, Markdown>();

  /** Render one item's text as markdown (assistant prose / user bubble). */
  function markdownLines(
    item: TranscriptItem,
    paddingX: number,
    style?: DefaultTextStyle,
  ): string[] {
    let md = markdownCache.get(item);
    if (!md) {
      md = new Markdown(item.text, paddingX, 0, MARKDOWN_THEME, style);
      markdownCache.set(item, md);
    } else {
      md.setText(item.text);
    }
    return md.render(Math.max(20, tui.terminal.columns - 4));
  }

  function renderItem(item: TranscriptItem, state: TuiViewState): string[] {
    switch (item.kind) {
      case "user":
        if (!item.text) return [];
        if (item.pending) {
          // Steered/queued injection (pi's steering display): dim » so it
          // reads as an interruption, not a fresh prompt.
          return [`\u001b[2m  » ${item.text.replace(/\r?\n/g, " ↵ ")}\u001b[0m`];
        }
        // Fresh prompt: markdown on a bg bubble (pi's UserMessageComponent).
        return markdownLines(item, 1, USER_TEXT_STYLE);
      case "assistant":
        return item.text ? markdownLines(item, 0) : [];
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
    let mark = "\u2714";
    let color = "32";
    if (item.streaming) {
      mark = "\u25cf";
      color = "33";
    } else if (failed) {
      mark = "\u2718";
      color = "31";
    }
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
    // `read src/foo.ts:40-80`), not raw JSON; result as first line + count;
    // wall-clock duration as trailing meta (pi status-line meta).
    const args = item.input !== undefined ? ` ${summarizeToolArgs(toolName, item.input)}` : "";
    const duration =
      item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
    lines.push(
      `\u001b[${color}m  ${mark} \u001b[0m${boldName}\u001b[2m${args}${duration}\u001b[0m`,
    );
    // Edit tool: the actual change as capped +/- lines (pi's diff rendering,
    // collapsed form) — WHAT changed, not just the path.
    if (toolName === "edit" && item.input !== undefined) {
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      for (const line of str(item.input.old_string).split("\n").slice(0, MAX_DIFF_LINES)) {
        lines.push(`\u001b[31m    - ${line.slice(0, 90)}\u001b[0m`);
      }
      for (const line of str(item.input.new_string).split("\n").slice(0, MAX_DIFF_LINES)) {
        lines.push(`\u001b[32m    + ${line.slice(0, 90)}\u001b[0m`);
      }
    }
    // Live streaming output (bash stdout): show the tail so long commands
    // give progress without flooding the transcript.
    if (item.output && item.streaming) {
      const tail = item.output.slice(-600);
      for (const line of tail.split("\n").slice(-4)) {
        if (line.trim()) lines.push(`\u001b[2m    ${line}\u001b[0m`);
      }
    }
    if (item.result !== undefined) {
      lines.push(`\u001b[2m    ${summarizeResult(item.result)}\u001b[0m`);
    }
    return lines;
  }

  /** ctrl+r overlay over the persistent history; a selection lands in the
   *  editor (not submitted — the user edits first, pi's behavior). */
  function openHistorySearch(): void {
    if (historyEntries.length === 0) {
      const hint = new Text("\u001b[2m  history is empty\u001b[0m", 0, 0);
      statusContainer.addChild(hint);
      tui.requestRender();
      setTimeout(() => {
        statusContainer.removeChild(hint);
        tui.requestRender();
      }, 1_500);
      return;
    }
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const overlayBox = new HistorySearchOverlay(
      new Text("  history search — type to filter, enter insert, esc cancel", 0, 0),
      historyEntries,
      EDITOR_THEME.selectList,
      (value) => {
        overlay.hide();
        resolve(value);
      },
      () => {
        overlay.hide();
        resolve(null);
      },
    );
    const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
    void promise.then((value) => {
      if (value !== null) editor.setText(value);
      tui.requestRender();
    });
  }

  tui.addChild(headerContainer);
  tui.addChild(transcript);
  tui.addChild(statusContainer);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  // Mouse tracking (normal tracking + SGR encoding): the wheel scrolls the
  // transcript. Restored in close(); Shift bypasses capture for text
  // selection.
  tui.terminal.write("\x1b[?1000h\x1b[?1006h\x1b[?1004h");

  return {
    render,
    waitForInput() {
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },
    setBusy(next: boolean) {
      busy = next;
      // The animated status line: a braille spinner + "working (Ns)" while
      // a run is live, removed when it settles. Loader drives its own timer
      // and calls requestRender on every frame; the elapsed timer ticks the
      // seconds.
      statusContainer.clear();
      if (next) {
        busySince = Date.now();
        loader = new Loader(
          tui,
          (s) => `\u001b[36m${s}\u001b[0m`,
          (s) => `\u001b[2m${s}\u001b[0m`,
          "working… (esc to abort)",
        );
        loader.start();
        statusContainer.addChild(loader);
        startElapsedTimer();
      } else {
        clearInterval(elapsedTimer);
        if (loader) {
          loader.stop();
          loader = null;
        }
        renderIdleFooter();
      }
      tui.requestRender();
    },
    onLiveInput(handler) {
      liveHandler = handler;
    },
    onLiveCommand(handler) {
      liveCommandHandler = handler;
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
        const fork = s.forkOf ? ` \u2442 ${s.forkOf.slice(0, 8)}` : "";
        const workspace = s.workspace ? ` [${s.workspace}]` : "";
        return {
          value: s.id,
          label: relativeTime(s.modifiedAt),
          description: `${base}${fork}${workspace}`,
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
    pickModel(models) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      const items = models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.description,
      }));
      const list = new SelectList(items, 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 32,
      });
      const overlayBox = new PickerOverlay(
        new Text("  pick model — ↑/↓ select, enter confirm, esc cancel", 0, 0),
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
    pickForkPoint(points) {
      const { promise, resolve } = Promise.withResolvers<number | null>();
      const items = points.map((p) => ({
        value: String(p.ordinal),
        label: `#${p.ordinal}`,
        description: p.text,
      }));
      const list = new SelectList(items, 10, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 4,
        maxPrimaryColumnWidth: 6,
      });
      const overlayBox = new PickerOverlay(
        new Text("  fork from message — ↑/↓ select, enter fork, esc cancel", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(Number(item.value));
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    setHeader(info) {
      headerInfo = "oma";
      headerModel = info.model ?? "";
      headerSession = info.sessionId ?? "";
      headerTitle = info.title ?? "";
      // Context usage is sticky: callers that only update the title keep
      // the last reading until a fresh one arrives.
      if (info.context !== undefined) headerContext = info.context;
      renderHeader();
      tui.requestRender();
    },
    setInputText(text) {
      editor.setText(text);
      tui.requestRender();
    },
    isFocused() {
      return focused;
    },
    notify() {
      tui.terminal.write("\x07");
    },
    close() {
      clearInterval(elapsedTimer);
      clearTimeout(quitTimer);
      dismissQuitHint();
      if (loader) loader.stop();
      tui.terminal.write("\x1b[?1000l\x1b[?1006l\x1b[?1004l");
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

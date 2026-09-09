import {
  applyBackgroundToLine,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type Terminal,
  Text,
  TUI,
  truncateToWidth,
} from "@chengchenccc/tui";
import {
  appendInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "../../core/session/input-history.js";
import type { SessionBranchNode } from "../../core/session/session-file.js";
import type { ProjectSettings } from "../../core/settings/project-settings.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { HistorySearchOverlay, OmaTranscriptContainer, PickerOverlay } from "./tui-components.js";
import { EDITOR_THEME, relativeTime, WELCOME_TIPS } from "./tui-format.js";
import { createOmaFrameProvider } from "./tui-frame-provider.js";
import type { TuiCommand, TuiIo } from "./tui-mode.js";
import { TuiRenderShell } from "./tui-render.js";
import type { TuiViewState } from "./view-state.js";

/** Pre-order branch-tree rows with git-graph prefixes (pi tree-selector
 *  semantics): indent grows only at branch points, single-child chains stay
 *  flat, ancestors leave "│" rails at their fork columns. */
export function layoutBranchTree(
  nodes: ReadonlyArray<SessionBranchNode>,
): Array<{ node: SessionBranchNode; prefix: string }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, SessionBranchNode[]>();
  const roots: SessionBranchNode[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }
  const multipleRoots = roots.length > 1;
  type Gutter = { position: number; show: boolean };
  // [node, lane, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
  type StackItem = [SessionBranchNode, number, boolean, boolean, boolean, Gutter[], boolean];
  const rows: Array<{ node: SessionBranchNode; prefix: string }> = [];
  const stack: StackItem[] = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push([
      roots[i]!,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      i === roots.length - 1,
      [],
      multipleRoots,
    ]);
  }
  while (stack.length > 0) {
    const [node, lane, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;
    const displayIndent = multipleRoots ? Math.max(0, lane - 1) : lane;
    const connectorLevel = showConnector && !isVirtualRootChild ? displayIndent - 1 : -1;
    const cells: string[] = [];
    for (let level = 0; level < displayIndent; level++) {
      const gutter = gutters.find((g) => g.position === level);
      if (level === connectorLevel) cells.push(isLast ? "└─ " : "├─ ");
      else cells.push(gutter?.show ? "│  " : "   ");
    }
    rows.push({ node, prefix: cells.join("") });

    const children = childrenOf.get(node.id) ?? [];
    const multipleChildren = children.length > 1;
    const childLane = multipleChildren || (justBranched && lane > 0) ? lane + 1 : lane;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const childGutters = connectorDisplayed
      ? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
      : gutters;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([
        children[i]!,
        childLane,
        multipleChildren,
        multipleChildren,
        i === children.length - 1,
        childGutters,
        false,
      ]);
    }
  }
  return rows;
}

/** One-shot SelectList overlay; resolves the picked value or null on esc. */
function pickOne(
  tui: TUI,
  title: string,
  items: ReadonlyArray<{ value: string; label: string; description?: string }>,
): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const list = new SelectList([...items], 10, EDITOR_THEME.selectList, {
    minPrimaryColumnWidth: 6,
    maxPrimaryColumnWidth: 42,
  });
  const overlayBox = new PickerOverlay(new Text(title, 0, 0), list);
  const overlay = tui.showOverlay(overlayBox, { width: "70%", anchor: "center" });
  list.onSelect = (item: { value: string }) => {
    overlay.hide();
    resolve(item.value);
  };
  list.onCancel = () => {
    overlay.hide();
    resolve(null);
  };
  return promise;
}

/** Notice-only overlay; resolves true when dismissed, null is not needed. */
function pickNotice(tui: TUI, title: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const list = new SelectList([{ value: "ok", label: "ok" }], 1, EDITOR_THEME.selectList, {
    minPrimaryColumnWidth: 2,
    maxPrimaryColumnWidth: 4,
  });
  const overlayBox = new PickerOverlay(new Text(title, 0, 0), list);
  const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
  list.onSelect = () => {
    overlay.hide();
    resolve(true);
  };
  list.onCancel = () => {
    overlay.hide();
    resolve(true);
  };
  return promise;
}

export function createTerminalIo(
  terminal: Terminal = new ProcessTerminal(),
  workspaceRoot: string = process.cwd(),
): TuiIo {
  const tui = new TUI(terminal);
  const transcript = new OmaTranscriptContainer();
  const statusContainer = new Container();
  const welcomeTip = WELCOME_TIPS[Math.floor(Math.random() * WELCOME_TIPS.length)] ?? "";
  const shell = new TuiRenderShell(tui, transcript, statusContainer, workspaceRoot, welcomeTip);
  const editorTheme: EditorTheme = {
    ...EDITOR_THEME,
    topBorder: (width: number): string => {
      if (!shell.statusLineText) return EDITOR_THEME.borderColor("─".repeat(width));
      // Re-fit the powerline status bar to the current width. The raw string
      // is width-independent; addStatusBar must not pre-truncate it, or a
      // terminal resize leaves a stale-width status line above the editor.
      const line = truncateToWidth(shell.statusLineText, width, "");
      return applyBackgroundToLine(line, width, (s) => `\u001b[48;5;234m${s}\u001b[0m`);
    },
  };
  const editor = new Editor(tui, editorTheme);
  shell.renderHeader();
  let pending: ((value: string | null) => void) | null = null;
  let busy = false;
  let liveHandler: ((text: string) => void) | null = null;
  let liveCommandHandler: ((text: string) => void) | null = null;
  let commandHandler: ((cmd: TuiCommand) => void) | null = null;
  let focusHandler: ((focused: boolean) => void) | null = null;
  let loader: Loader | null = null;
  let busySince = 0;
  let busySeconds = 0;
  let elapsedTimer: Timer | undefined;
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
  let escArmed = false;
  let escTimer: Timer | undefined;
  let escHint: Text | null = null;

  function startElapsedTimer(): void {
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      if (!busy) return;
      busySeconds = Math.floor((Date.now() - busySince) / 1000);
      shell.setBusySeconds(busySeconds);
      shell.updateWorkingMessage();
    }, 1000);
  }

  /** Derive a short human-readable summary for the currently streaming
   *  activity (omp's intent/working message). Prefer a live tool intent;
   *  when the model is composing a response, surface the first line of its
   *  thinking or output so the composer is never just "working…". */

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
  /** Idle esc-esc opens the branch tree. A single esc only arms so the esc
   *  that CLOSES an overlay can never immediately re-summon it. */
  function dismissEscArm(): void {
    escArmed = false;
    clearTimeout(escTimer);
    if (escHint) {
      statusContainer.removeChild(escHint);
      escHint = null;
    }
  }

  function armEsc(): void {
    dismissEscArm();
    escArmed = true;
    escHint = new Text("\u001b[2m  press esc again for branch tree\u001b[0m", 0, 0);
    statusContainer.addChild(escHint);
    tui.requestRender();
    escTimer = setTimeout(() => {
      dismissEscArm();
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
    dismissEscArm();
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
  // Last rendered state: resize/setHeader rebuild the transcript from it.

  tui.addInputListener((data) => {
    // Focus reporting (CSI 1004): ESC[I focused, ESC[O unfocused.
    if (data === "\x1b[I") {
      focused = true;
      focusHandler?.(true);
      return { consume: true };
    }
    if (data === "\x1b[O") {
      focused = false;
      focusHandler?.(false);
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      // An overlay must own Esc: abort/forkTree must not steal the key while
      // the user is trying to cancel the overlay, or it becomes impossible to
      // close (e.g. branch-tree picker).
      if (tui.hasOverlay()) return undefined;
      if (busy) {
        if (commandHandler) commandHandler("abort");
        return { consume: true };
      }
      if (!editor.isShowingAutocomplete() && commandHandler) {
        // esc-esc summons; the first esc only arms (quit-arm pattern) so an
        // extra esc while dismissing overlays never reopens the tree.
        if (escArmed) {
          dismissEscArm();
          commandHandler("forkTree");
        } else {
          armEsc();
        }
        return { consume: true };
      }
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
    // ctrl+c aborts the live run when busy and quits when idle.
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
      new Text("  history search — filter, enter, esc", 0, 0),
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

  tui.setFrameProvider(
    createOmaFrameProvider({
      transcript,
      statusContainer,
      editor,
      shell,
    }),
  );
  tui.addChild(transcript);
  tui.addChild(statusContainer);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  tui.terminal.write("\x1b[?1004h");

  return {
    render(state: TuiViewState) {
      shell.render(state);
    },
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
        shell.addStatusBar();
        shell.setBusy(true, null, 0);
        busySince = Date.now();
        busySeconds = 0;
        shell.setBusySeconds(0);
        loader = new Loader(
          tui,
          (s) => `\u001b[36m${s}\u001b[0m`,
          (s) => `\u001b[2m${s}\u001b[0m`,
          "working… (esc to abort)",
        );
        loader.start();
        statusContainer.addChild(loader);
        shell.setBusy(true, loader, 0);
        shell.updateWorkingMessage();
        startElapsedTimer();
      } else {
        clearInterval(elapsedTimer);
        busySeconds = 0;
        if (loader) {
          loader.stop();
          loader = null;
        }
        shell.setBusy(false, null, 0);
        shell.renderIdleFooter();
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
    onFocus(handler) {
      focusHandler = handler;
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
        new Text("  resume session — select, enter, esc", 0, 0),
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
        new Text("  pick model — select, enter, esc", 0, 0),
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
    confirmApproval(req) {
      const { promise, resolve } = Promise.withResolvers<"allow" | "deny" | null>();
      const list = new SelectList(
        [
          { value: "allow", label: "allow", description: "run the tool" },
          { value: "deny", label: "deny", description: "block with an error result" },
        ],
        2,
        EDITOR_THEME.selectList,
        { minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: 8 },
      );
      const overlayBox = new PickerOverlay(
        new Text(
          `  approve ${req.toolName}${req.reason ? ` — ${req.reason}` : ""} — select, enter, esc`,
          0,
          0,
        ),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "60%", anchor: "center" });
      list.onSelect = (item) => {
        overlay.hide();
        resolve(item.value === "allow" ? "allow" : "deny");
      };
      list.onCancel = () => {
        overlay.hide();
        resolve(null);
      };
      return promise;
    },
    askQuestions(input) {
      // ponytail: TUI v1 fully supports single-select questions via the
      // SelectList overlay; multi/text degrade to a notice overlay resolving
      // null (tool fails closed). Upgrade path: an Input-based form overlay
      // (packages/tui Input is Focusable) for text + checkbox rows for multi.
      return (async () => {
        const answers: Array<{
          id: string;
          selectedValues: string[];
          freeText?: string;
        }> = [];
        for (const q of input.questions) {
          if (q.kind === "text" || q.multi) {
            const unsupported = await pickNotice(
              tui,
              `  ${q.question} — ${q.kind === "text" ? "text" : "multi-select"} input not supported in TUI yet — esc`,
            );
            if (!unsupported) return null;
            continue;
          }
          const options = q.options ?? [];
          const picked = await pickOne(
            tui,
            `  ${q.question} — select, enter, esc${q.header ? ` — ${q.header}` : ""}`,
            options.map((o) => ({
              value: o.value,
              label: o.label + (q.recommended === o.value ? " (Recommended)" : ""),
              description: o.description,
            })),
          );
          if (picked === null) return null;
          answers.push({ id: q.id, selectedValues: [picked] });
        }
        return { answers };
      })();
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
        new Text("  fork from message — select, enter, esc", 0, 0),
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
    pickBranchTree(nodes) {
      const { promise, resolve } = Promise.withResolvers<string | null>();
      // Git-graph layout (pi tree-selector): a node's indent only grows at
      // branch points — single-child chains stay flat, so a linear session
      // renders as one column instead of one-indent-per-message. Rails:
      // "│" at ancestor fork columns, "├─/└─" for children of a fork.
      const items = layoutBranchTree(nodes)
        .slice(0, 200)
        .map(({ node: n, prefix }) => {
          const roleColor =
            n.role === "user" ? "\u001b[36m" : n.role === "assistant" ? "\u001b[32m" : "\u001b[2m";
          const ordinal = n.ordinal !== undefined ? ` #${n.ordinal}` : "";
          return {
            value: n.id,
            label: `${prefix}${roleColor}${n.role}${ordinal}\u001b[0m`,
            description: n.text.replace(/\s+/g, " ").slice(0, 60),
          };
        });
      const list = new SelectList(items, 12, EDITOR_THEME.selectList, {
        minPrimaryColumnWidth: 14,
        maxPrimaryColumnWidth: 32,
      });
      const overlayBox = new PickerOverlay(
        new Text("  fork from branch node — select, enter, esc-esc to open", 0, 0),
        list,
      );
      const overlay = tui.showOverlay(overlayBox, { width: "75%", anchor: "center" });
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
    editSettings(settings) {
      const { promise, resolve } = Promise.withResolvers<ProjectSettings | null>();
      const box = new SettingsOverlay(settings, () => {
        handle.hide();
        resolve(box.getSettings());
      });
      const handle = tui.showOverlay(box, { width: "70%", anchor: "center" });
      return promise;
    },
    setHeader(info) {
      shell.setHeader(info.model ?? "", info.sessionId ?? "", info.title ?? "", info.context);
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
      clearTimeout(escTimer);
      dismissQuitHint();
      dismissEscArm();
      if (loader) loader.stop();
      tui.terminal.write("\x1b[?1004l");
      tui.stop();
    },
  };
}

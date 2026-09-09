import {
  CachedOutputBlock,
  Card,
  type Container,
  type DefaultTextStyle,
  type Loader,
  Markdown,
  type OutputBlockSection,
  renderStatusBar,
  renderToolHeader,
  Text,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@chengchenccc/tui";
import { countRunningBashJobs } from "../../core/tools/bash.js";
import { countRunningEvalJobs } from "../../core/tools/eval.js";
import type { OmaTranscriptContainer } from "./tui-components.js";
import {
  cleanHeaderTitle,
  contextColor,
  formatWorkspace,
  gitStatus,
  MARKDOWN_THEME,
  MAX_DIFF_LINES,
  prettyJson,
  renderGitSegment,
  summarizeResult,
  summarizeToolArgs,
  USER_TEXT_STYLE,
} from "./tui-format.js";
import { renderTaskTool, renderTodoTool } from "./tui-tool-render.js";
import { TuiTranscriptReconciler } from "./tui-transcript-reconciler.js";
import type { TranscriptItem, TuiViewState } from "./view-state.js";

/** Renders transcript items to display lines, memoizing markdown/tool blocks.
 *  Extracted from tui-io.ts to keep the io assembly file under 500 lines. */
export class TuiItemRenderer {
  private readonly markdownCache = new WeakMap<TranscriptItem, Markdown>();
  private readonly itemLineCache = new WeakMap<
    TranscriptItem,
    { lines: string[]; showThinking: boolean; showToolDetail: boolean; width: number }
  >();
  private readonly toolBlockCache = new WeakMap<TranscriptItem, CachedOutputBlock>();

  constructor(private readonly tui: TUI) {}

  renderItem(item: TranscriptItem, state: TuiViewState): string[] {
    const cached = this.itemLineCache.get(item);
    if (
      cached &&
      !item.streaming &&
      cached.showThinking === state.showThinking &&
      cached.showToolDetail === state.showToolDetail &&
      cached.width === this.tui.terminal.columns
    ) {
      return cached.lines;
    }
    const lines = this.computeRenderItem(item, state);
    if (!item.streaming) {
      this.itemLineCache.set(item, {
        lines,
        showThinking: state.showThinking,
        showToolDetail: state.showToolDetail,
        width: this.tui.terminal.columns,
      });
    }
    return lines;
  }

  private computeRenderItem(item: TranscriptItem, state: TuiViewState): string[] {
    switch (item.kind) {
      case "user":
        if (!item.text) return [];
        if (item.pending) {
          return [`\u001b[2m  » ${item.text.replace(/\r?\n/g, " ↵ ")}\u001b[0m`];
        }
        return this.markdownLines(item, 1, 1, USER_TEXT_STYLE);
      case "assistant": {
        const lines: string[] = [];
        if (item.thinking) lines.push(...this.renderThinking(item.thinking, state.showThinking));
        if (item.text) lines.push(...this.markdownLines(item, 1, 0));
        return lines;
      }
      case "thinking":
        return this.renderThinking(item.text, state.showThinking);
      case "tool":
        return this.renderTool(item, state.showToolDetail);
      case "status":
        return [`\u001b[2m  [${item.text}]\u001b[0m`];
      case "error":
        return [`\u001b[31m  error: ${item.text}\u001b[0m`];
    }
  }

  private markdownLines(
    item: TranscriptItem,
    paddingX: number,
    paddingY: number,
    style?: DefaultTextStyle,
  ): string[] {
    let md = this.markdownCache.get(item);
    if (!md) {
      md = new Markdown(item.text, paddingX, paddingY, MARKDOWN_THEME, style);
      this.markdownCache.set(item, md);
    } else {
      md.setText(item.text);
    }
    return md.render(this.tui.terminal.columns);
  }

  private renderThinking(text: string, expanded: boolean): string[] {
    if (!text) return [];
    const firstLine = text.split("\n", 1)[0] ?? "";
    const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
    if (!expanded) {
      if (text.length === firstLine.length) return [dim(`  ~ ${firstLine}`)];
      return [dim(`  ~ ${firstLine} … (ctrl+t)`)];
    }
    const wrapWidth = Math.max(20, this.tui.terminal.columns - 6);
    return wrapTextWithAnsi(text, wrapWidth).map((line) => dim(`  ~ ${line}`));
  }

  private renderTool(item: TranscriptItem, expanded: boolean): string[] {
    const toolName = item.text.replace(/…$/, "");
    if (toolName === "todo" || toolName === "todo_read" || toolName === "todo_write") {
      return renderTodoTool(item, expanded);
    }
    if (toolName === "task" || toolName === "task_list" || toolName === "task_output") {
      return renderTaskTool(item, expanded);
    }
    const failed =
      item.result !== undefined &&
      (item.result.isError === true || item.result.error !== undefined);
    const running = item.streaming;
    const mark = running ? "\u27f3" : failed ? "\u2718" : "\u2714";
    const state = running ? "running" : failed ? "error" : "success";
    const titleColor =
      state === "running" ? "\u001b[33m" : state === "error" ? "\u001b[31m" : "\u001b[32m";
    const wallMs =
      item.durationMs ??
      (item.streaming && item.startedAt !== undefined ? Date.now() - item.startedAt : undefined);
    const wall = wallMs === undefined ? "—" : `${(wallMs / 1000).toFixed(2)}s`;
    const timeoutMs = item.timeoutMs;
    const timeout = timeoutMs === undefined ? "—" : `${(timeoutMs / 1000).toFixed(0)}s`;
    const header = renderToolHeader({
      icon: mark,
      title: toolName,
      meta: [`\u001b[2m⟦Wall: ${wall} | Timeout: ${timeout}⟧\u001b[0m`],
      titleColor,
    });

    const sections: OutputBlockSection[] = [];

    if (item.input !== undefined) {
      const lines: string[] = [];
      if (expanded) {
        for (const line of prettyJson(item.input).split("\n")) {
          lines.push(`\u001b[2m${line}\u001b[0m`);
        }
      } else {
        lines.push(`\u001b[2m└ ${summarizeToolArgs(toolName, item.input)}\u001b[0m`);
      }
      sections.push({ lines });
    }

    if (toolName === "edit" && item.input !== undefined) {
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const lines: string[] = [];
      for (const line of str(item.input.old_string).split("\n").slice(0, MAX_DIFF_LINES)) {
        lines.push(`\u001b[31m- ${line.slice(0, 90)}\u001b[0m`);
      }
      for (const line of str(item.input.new_string).split("\n").slice(0, MAX_DIFF_LINES)) {
        lines.push(`\u001b[32m+ ${line.slice(0, 90)}\u001b[0m`);
      }
      sections.push({ lines });
    }

    if (item.output && item.streaming) {
      const tail = item.output.slice(-600);
      const lines: string[] = [];
      for (const line of tail.split("\n").slice(-4)) {
        if (line.trim()) lines.push(`\u001b[2m${line}\u001b[0m`);
      }
      sections.push({ lines });
    }

    if (item.result !== undefined) {
      const content = typeof item.result.content === "string" ? item.result.content : null;
      const resultColor = failed ? "\u001b[31m" : "\u001b[2m";
      const lines: string[] = [];
      if (content !== null) {
        let textContent = content.trimEnd();
        const trimmed = textContent.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            textContent = prettyJson(JSON.parse(textContent));
          } catch {
            // non-JSON that merely starts with a bracket: keep raw text
          }
        }
        const outputLines = textContent
          .split("\n")
          .filter((line) => !(!failed && /\[exit: \d+\]/.test(line)));
        const maxOut = expanded ? 12 : 4;
        const display = outputLines.slice(0, maxOut);
        const isCodeResult = toolName === "read" || toolName === "write";
        for (const line of display) {
          const truncated = truncateToWidth(line, this.tui.terminal.columns - 6);
          lines.push(
            isCodeResult && !failed
              ? MARKDOWN_THEME.codeBlock(truncated)
              : `${resultColor}${truncated}\u001b[0m`,
          );
        }
        if (outputLines.length > maxOut) {
          lines.push(`\u001b[2m… ${outputLines.length - maxOut} more lines · (ctrl+o)\u001b[0m`);
        } else if (!expanded) {
          lines.push(`\u001b[2m· (ctrl+o)\u001b[0m`);
        }
      } else {
        const summary = summarizeResult(item.result);
        if (summary) lines.push(`${resultColor}${summary}\u001b[0m`);
      }
      if (content !== null || Object.keys(item.result).length > 0) {
        sections.push({ label: "Output", lines });
      }
    }

    let block = this.toolBlockCache.get(item);
    if (!block) {
      block = new CachedOutputBlock();
      this.toolBlockCache.set(item, block);
    }
    return [
      ...block.render({
        header,
        state,
        sections,
        width: this.tui.terminal.columns,
        bg: (line: string) => `\u001b[48;5;234m${line}\u001b[0m`,
      }),
    ];
  }
}

/** Header/status/transcript render shell for createTerminalIo. Owns the
 *  display-only mutable state (header fields, busy, status line) so the io
 *  assembly file stays small. */
export class TuiRenderShell {
  private headerInfo = "oma";
  private headerModel = "";
  private headerSession = "";
  private headerTitle = "";
  private headerContext = "";
  private busy = false;
  private loader: Loader | null = null;
  private busySeconds = 0;
  private currentState: TuiViewState | null = null;
  statusLineText = "";
  private readonly itemRenderer: TuiItemRenderer;
  private readonly reconciler: TuiTranscriptReconciler;
  lastLiveStartRow = 0;
  lastTotalRows = 0;
  /** Session id the header block was last printed for (cc-style: the
   *  banner scrolls away with the transcript and re-prints per session). */
  private lastPrintedSession: string | null = null;
  private welcomeTipShown = false;

  constructor(
    private readonly tui: TUI,
    private readonly transcript: OmaTranscriptContainer,
    private readonly statusContainer: Container,
    private readonly workspaceRoot: string,
    private readonly welcomeTip: string,
  ) {
    this.itemRenderer = new TuiItemRenderer(tui);
    this.reconciler = new TuiTranscriptReconciler();
  }

  setBusy(busy: boolean, loader: Loader | null, busySeconds: number): void {
    this.busy = busy;
    this.loader = loader;
    this.busySeconds = busySeconds;
  }

  setBusySeconds(busySeconds: number): void {
    this.busySeconds = busySeconds;
  }

  setCurrentState(state: TuiViewState): void {
    this.currentState = state;
  }

  setHeader(model: string, session: string, title: string, context?: string): void {
    this.headerModel = model;
    this.headerSession = session;
    this.headerTitle = title;
    if (context !== undefined) this.headerContext = context;
    this.renderHeader();
    if (!this.busy) {
      this.statusContainer.clear();
      this.renderIdleFooter();
    }
    this.tui.requestRender();
  }

  /** Print the header INTO the transcript: it scrolls away with content
   *  (cc-style) instead of pinning as live chrome. Re-prints only when the
   *  session identity changes — model/context stay visible in the status
   *  bar. */
  renderHeader(): void {
    if (this.lastPrintedSession !== null && this.headerSession === this.lastPrintedSession) {
      return;
    }
    const banner = [
      "\u001b[36m  ██████╗ ███╗   ███╗ █████╗ \u001b[0m",
      "\u001b[36m ██╔═══██╗████╗ ████║██╔══██╗\u001b[0m",
      "\u001b[36m ██║   ██║██╔████╔██║███████║\u001b[0m",
      "\u001b[36m ██║   ██║██║╚██╔╝██║██╔══██║\u001b[0m",
      "\u001b[36m ╚██████╔╝██║ ╚═╝ ██║██║  ██║\u001b[0m",
      "\u001b[36m  ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝\u001b[0m",
    ];
    const infoLines: string[] = [];
    infoLines.push(`\u001b[1m  ${this.headerInfo}\u001b[0m`);
    const hTitle = cleanHeaderTitle(this.headerTitle);
    if (hTitle) infoLines.push(`\u001b[2m  ${hTitle}\u001b[0m`);
    if (this.headerModel) {
      infoLines.push(`\u001b[2m  model:\u001b[0m \u001b[36m${this.headerModel}\u001b[0m`);
    }
    infoLines.push(
      `\u001b[2m  workspace:\u001b[0m \u001b[38;5;39m${formatWorkspace(this.workspaceRoot)}\u001b[0m`,
    );
    const hGit = gitStatus(this.workspaceRoot);
    if (hGit) infoLines.push(`\u001b[2m  git:\u001b[0m ${renderGitSegment(hGit)}`);
    if (this.headerSession)
      infoLines.push(`\u001b[2m  session:\u001b[0m ${this.headerSession.slice(0, 8)}`);
    if (this.headerContext) infoLines.push(`\u001b[2m  context:\u001b[0m ${this.headerContext}`);
    if (!this.welcomeTipShown && this.welcomeTip) {
      infoLines.push(`\u001b[33m  ${this.welcomeTip}\u001b[0m`);
      this.welcomeTipShown = true;
    }

    const combined: string[] = [];
    const rows = Math.max(banner.length, infoLines.length);
    for (let i = 0; i < rows; i++) {
      const left = banner[i] ?? "";
      const right = infoLines[i] ?? "";
      combined.push(`${left}${left ? "   " : ""}${right}`);
    }
    const headerCard = new Card(
      combined.map((line) => new Text(truncateToWidth(line, this.tui.terminal.columns - 2), 0, 0)),
      {
        paddingX: 0,
        paddingY: 0,
        border: { color: (s: string) => `\u001b[2m${s}\u001b[0m` },
      },
    );
    for (const line of headerCard.render(this.tui.terminal.columns)) {
      this.transcript.addChild(new Text(truncateToWidth(line, this.tui.terminal.columns), 0, 0));
    }
    this.lastPrintedSession = this.headerSession;
  }

  currentActivitySummary(): string | undefined {
    if (!this.currentState) return undefined;
    for (let r = this.currentState.runs.length - 1; r >= 0; r--) {
      const run = this.currentState.runs[r]!;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]!;
        if (item.kind === "tool" && item.streaming) {
          const name = item.text.replace(/…$/, "");
          const intent =
            typeof item.input?.intent === "string"
              ? item.input.intent.trim()
              : typeof item.input?.description === "string"
                ? item.input.description.trim()
                : "";
          const summary = intent
            ? intent
            : item.input !== undefined
              ? summarizeToolArgs(name, item.input)
              : "";
          return summary.trim() ? `${name} · ${summary}` : name;
        }
        if (item.kind === "assistant" && item.streaming) {
          const source = `${item.thinking ?? ""}
${item.text ?? ""}`;
          const first = source.split("\n", 1)[0]?.trim() ?? "";
          if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
        }
      }
    }
    // Fallback: a busy run with a tool item (even if the streaming flag is
    // lost) should never read as a bare "working…".
    for (let r = this.currentState.runs.length - 1; r >= 0; r--) {
      const run = this.currentState.runs[r]!;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]!;
        if (item.kind === "tool" && item.text) return item.text.replace(/…$/, "");
      }
    }
    return undefined;
  }

  updateWorkingMessage(): void {
    if (!this.busy || !this.loader) return;
    const summary = this.currentActivitySummary();
    const seconds = this.busySeconds > 0 ? ` · ${this.busySeconds}s` : "";
    const msg = summary
      ? `${summary}${seconds} (esc to abort)`
      : `working…${seconds} (esc to abort)`;
    this.loader.setMessage(msg);
  }

  addStatusBar(): void {
    const git = gitStatus(this.workspaceRoot);
    const segs: Array<{
      text: string;
      chip?: boolean;
      fg?: string;
      bg?: string;
    }> = [];
    if (this.headerModel) {
      segs.push({ text: this.headerModel, chip: true, bg: "\u001b[48;5;25m" });
    }
    segs.push({ text: formatWorkspace(this.workspaceRoot), fg: "\u001b[38;5;39m" });
    // M-bash/M-eval: surface running background jobs (bash bg_N / eval eval_N).
    const runningBg = countRunningBashJobs() + countRunningEvalJobs();
    if (runningBg > 0) {
      segs.push({ text: `⏵ ${runningBg} bg`, chip: true, bg: "\u001b[48;5;22m" });
    }
    if (git) segs.push({ text: renderGitSegment(git) });
    if (this.headerSession) segs.push({ text: this.headerSession.slice(0, 8), fg: "\u001b[2m" });
    if (this.headerContext)
      segs.push({ text: this.headerContext, fg: contextColor(this.headerContext) });
    if (segs.length > 0) {
      this.statusLineText = renderStatusBar(segs);
    }
  }

  /** Background job settlement (M-bash/M-eval): append a visible block
   *  with the exit state and output tail. Native scrollback is
   *  append-only, so this lands as a new transcript block rather than
   *  rewriting the original "Backgrounded as job …" line. */
  appendNotice(text: string): void {
    this.transcript.addChild(new Text(`\u001b[36m  ⏵ ${text}\u001b[0m`, 0, 0));
    this.tui.requestRender();
  }

  renderIdleFooter(): void {
    this.addStatusBar();
  }

  render(state: TuiViewState): void {
    this.setCurrentState(state);
    this.transcript.setDeferCommit(
      state.runs.some(
        (r) =>
          r.running &&
          r.items.some(
            (i) =>
              i.kind === "assistant" &&
              (i.text.includes("```mermaid") || i.text.includes("~~~mermaid")),
          ),
      ),
    );
    if (this.busy) this.updateWorkingMessage();
    const result = this.reconciler.reconcile(this.transcript, state.runs, state, (item) =>
      this.itemRenderer.renderItem(item, state),
    );
    this.lastLiveStartRow = result.liveStartRow;
    this.lastTotalRows = result.totalRows;
    if (state.runs.length === 0 && this.welcomeTip && this.transcript.children.length === 0) {
      this.transcript.addChild(new Text(`\u001b[33m  ${this.welcomeTip}\u001b[0m`, 0, 0));
    }
    this.renderIdleFooter();
    if (result.didReset) {
      this.tui.requestRender(true);
    } else {
      this.tui.requestRender();
    }
  }
}

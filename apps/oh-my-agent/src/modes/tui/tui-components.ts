import {
  Container,
  type FramePlan,
  Input,
  matchesKey,
  type NativeScrollbackCommittedRows,
  type NativeScrollbackLiveRegion,
  type NativeScrollbackReplay,
  type RenderStablePrefix,
  SelectList,
  type SelectListTheme,
  type TerminalFrameProvider,
  type Text,
} from "@chengchenccc/tui";
import { overlayLines } from "./tui-format.js";

export class PickerOverlay extends Container {
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
  override render(width: number): string[] {
    return overlayLines(super.render(Math.max(1, width - 2)), width);
  }
}

/** Overlay for ctrl+r history search (pi's HistorySearchComponent, lazy
 *  form): a query input plus a SelectList rebuilt per keystroke. Navigation
 *  keys go to the list; everything else edits the query. */
export class HistorySearchOverlay extends Container {
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
  override render(width: number): string[] {
    return overlayLines(super.render(Math.max(1, width - 2)), width);
  }
}

export class OmaTranscriptContainer
  extends Container
  implements
    NativeScrollbackCommittedRows,
    NativeScrollbackLiveRegion,
    NativeScrollbackReplay,
    RenderStablePrefix,
    TerminalFrameProvider
{
  /** Rows already written to native scrollback (acknowledged frontier). */
  private committedRows = 0;
  /** Desired commit boundary set by the render shell each frame. */
  private targetCommittedRows = 0;
  private lastLines: string[] = [];
  private lastWidth = -1;
  private nextBatchId = 1;
  private offeredBatch: { id: number; end: number } | undefined;
  private deferCommit = false;

  /** While a run is live, mermaid/code rows may still re-layout on a later
   *  chunk; don't advance the scrollback frontier until the run settles
   *  (omp defers native-scrollback settling wholesale for live blocks). */
  setDeferCommit(defer: boolean): void {
    this.deferCommit = defer;
  }

  /** Records the desired commit boundary; `peekFinalizedBatch` turns it into
   *  an incremental history packet only when it is behind the frontier. */
  setNativeScrollbackCommittedRows(rows: number): void {
    if (this.deferCommit) return;
    this.targetCommittedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
    if (this.targetCommittedRows < this.committedRows)
      this.targetCommittedRows = this.committedRows;
  }

  getNativeScrollbackLiveRegionStart(): number | undefined {
    return this.committedRows;
  }

  getRenderStablePrefixRows(): number {
    return this.committedRows;
  }

  prepareNativeScrollbackReplay(): void {
    this.lastLines = [];
    this.lastWidth = -1;
  }

  override clear(): void {
    super.clear();
    this.lastLines = [];
    this.lastWidth = -1;
    this.committedRows = 0;
    this.targetCommittedRows = 0;
    this.offeredBatch = undefined;
  }

  /** Total rows currently in the live (not-yet-committed) tail. */
  liveRowCount(width: number): number {
    this.ensureFullRender(width);
    let rows = 0;
    for (
      let i = Math.min(this.committedRows, this.children.length);
      i < this.children.length;
      i++
    ) {
      rows += this.children[i]!.render(width).length;
    }
    return rows;
  }

  /** Render only the live tail, keeping the most recent `maxRows`. */
  renderViewport(width: number, maxRows: number): string[] {
    this.ensureFullRender(width);
    const live: string[] = [];
    for (
      let i = Math.min(this.committedRows, this.children.length);
      i < this.children.length;
      i++
    ) {
      const childLines = this.children[i]!.render(width);
      for (const line of childLines) live.push(line);
    }
    if (live.length > maxRows) return live.slice(live.length - maxRows);
    return live;
  }

  /** Populate the cached full-render baseline on first paint or a width change. */
  private ensureFullRender(width: number): void {
    if (this.lastWidth !== width || this.lastLines.length === 0) {
      this.lastLines = super.render(width);
      this.lastWidth = width;
    }
  }

  /** Offer the next uncommitted prefix as one history batch (omp peek).
   *  Returns only the *new* rows (from the frontier), never the cumulative
   *  prefix, so the terminal appends each packet exactly once. */
  peekFinalizedBatch(width: number): { id: number; end: number } | undefined {
    if (this.deferCommit) return undefined;
    if (this.offeredBatch !== undefined) return this.offeredBatch;
    if (this.targetCommittedRows <= this.committedRows || this.lastWidth !== width)
      return undefined;
    const end = this.targetCommittedRows;
    const batch = { id: this.nextBatchId++, end };
    this.offeredBatch = batch;
    return batch;
  }

  /** Acknowledges the offered batch, advancing the frontier (omp ack). */
  acknowledgeFinalizedBatch(id: number): void {
    if (this.offeredBatch === undefined || this.offeredBatch.id !== id) return;
    this.committedRows = Math.max(this.committedRows, this.offeredBatch.end);
    this.offeredBatch = undefined;
  }

  /** Render the currently-offered history packet rows (no full re-render). */
  renderOfferedHistory(width: number): { id: number; rows: string[] } | undefined {
    const batch = this.peekFinalizedBatch(width);
    if (!batch) return undefined;
    return { id: batch.id, rows: this.renderRange(this.committedRows, batch.end, width) };
  }

  /** Render the children in `[start, end)` as rows (used for history packets). */
  renderRange(start: number, end: number, width: number): string[] {
    const out: string[] = [];
    for (let i = start; i < Math.min(end, this.children.length); i++) {
      const childLines = this.children[i]!.render(width);
      for (const line of childLines) out.push(line);
    }
    return out;
  }

  /** Frame provider viewport = full render; history = uncommitted frontier
   *  rows to append to native scrollback. */
  renderFrame(opts: { columns: number; rows: number }): FramePlan {
    const viewport = this.render(opts.columns);
    const batch = this.peekFinalizedBatch(opts.columns);
    return {
      viewport,
      history: batch
        ? { id: batch.id, rows: this.renderRange(this.committedRows, batch.end, opts.columns) }
        : undefined,
    };
  }

  /** Replay the committed prefix after a resize/replay (force full re-compose). */
  beginReplay(): void {
    this.offeredBatch = undefined;
    this.committedRows = 0;
    this.targetCommittedRows = 0;
    this.lastLines = [];
    this.lastWidth = -1;
  }

  /** Graceful shutdown flush: offer + ack the committed prefix, then reset. */
  beginHistoryFlush(): void {
    const batch = this.peekFinalizedBatch(this.lastWidth);
    if (batch) this.acknowledgeFinalizedBatch(batch.id);
    this.beginReplay();
  }

  override render(width: number): string[] {
    // Steady-state frames reuse the committed prefix (rows already in native
    // scrollback) and only compose children at/after the seam, making each
    // frame O(live tail) instead of O(history). A width change forces a full
    // re-layout of the prefix too.
    if (this.lastWidth !== width || this.children.length === 0) {
      const all = super.render(width);
      this.lastLines = all;
      this.lastWidth = width;
      return all;
    }
    const start = Math.min(this.committedRows, this.children.length);
    // Cheap committed-prefix audit: the last committed row must still match
    // its cached bytes, otherwise the prefix drifted and we re-layout fully.
    if (start > 0) {
      const audit = this.children[start - 1]?.render(width)?.[0] ?? "";
      if (audit !== this.lastLines[start - 1]) {
        const all = super.render(width);
        this.lastLines = all;
        this.lastWidth = width;
        return all;
      }
    }
    const prefix = this.lastLines.slice(0, Math.max(0, start));
    const tail: string[] = [];
    for (let i = start; i < this.children.length; i++) {
      tail.push(...this.children[i]!.render(width));
    }
    this.lastLines = [...prefix, ...tail];
    return this.lastLines;
  }
}

/** Production TuiIo over the real terminal. The optional terminal override
 *  is the test seam: e2e tests inject a VirtualTerminal (xterm headless). */

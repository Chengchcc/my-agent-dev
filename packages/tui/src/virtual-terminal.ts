import type { IBufferCell, IBufferLine, Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "./terminal.ts";

// Extract Terminal class from the module
const XtermTerminal = xterm.Terminal;

/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export class VirtualTerminal implements Terminal {
  private xterm: XtermTerminalType;
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private _columns: number;
  private _rows: number;

  constructor(columns = 80, rows = 24) {
    this._columns = columns;
    this._rows = rows;

    // Create xterm instance with specified dimensions
    this.xterm = new XtermTerminal({
      cols: columns,
      rows: rows,
      // Disable all interactive features for testing
      disableStdin: true,
      allowProposedApi: true,
    });
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    // Enable bracketed paste mode for consistency with ProcessTerminal
    this.xterm.write("\x1b[?2004h");
  }

  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
    // No-op for virtual terminal - no stdin to drain
  }

  stop(): void {
    // Disable bracketed paste mode
    this.xterm.write("\x1b[?2004l");
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  write(data: string): void {
    this.xterm.write(data);
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  get kittyProtocolActive(): boolean {
    // Virtual terminal always reports Kitty protocol as active for testing
    return true;
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      // Move down
      this.xterm.write(`\x1b[${lines}B`);
    } else if (lines < 0) {
      // Move up
      this.xterm.write(`\x1b[${-lines}A`);
    }
    // lines === 0: no movement
  }

  hideCursor(): void {
    this.xterm.write("\x1b[?25l");
  }

  showCursor(): void {
    this.xterm.write("\x1b[?25h");
  }

  clearLine(): void {
    this.xterm.write("\x1b[K");
  }

  clearFromCursor(): void {
    this.xterm.write("\x1b[J");
  }

  clearScreen(): void {
    this.xterm.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
  }

  setTitle(title: string): void {
    // OSC 0;title BEL - set terminal window title
    this.xterm.write(`\x1b]0;${title}\x07`);
  }

  setProgress(_active: boolean): void {}

  // Test-specific methods not in Terminal interface

  /**
   * Simulate keyboard input
   */
  sendInput(data: string): void {
    if (this.inputHandler) {
      this.inputHandler(data);
    }
  }

  /**
   * Resize the terminal
   */
  resize(columns: number, rows: number): void {
    this._columns = columns;
    this._rows = rows;
    this.xterm.resize(columns, rows);
    if (this.resizeHandler) {
      this.resizeHandler();
    }
  }

  /**
   * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
   */
  async flush(): Promise<void> {
    // Write an empty string to ensure all previous writes are flushed
    return new Promise<void>((resolve) => {
      this.xterm.write("", () => resolve());
    });
  }

  /**
   * Flush and get viewport - convenience method for tests
   */
  async flushAndGetViewport(): Promise<string[]> {
    await this.flush();
    return this.getViewport();
  }

  /**
   * Get the visible viewport (what's currently on screen)
   * Note: You should use getViewportAfterWrite() for testing after writing data
   */
  getViewport(): string[] {
    const lines: string[] = [];
    const buffer = this.xterm.buffer.active;

    // Get only the visible lines (viewport)
    for (let i = 0; i < this.xterm.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (line) {
        lines.push(line.translateToString(true));
      } else {
        lines.push("");
      }
    }

    return lines;
  }

  /**
   * Get the entire scroll buffer
   */
  /**
   * Like getViewport() but re-emits per-cell SGR styling (fg/bg/bold/dim/…)
   * so snapshot tooling can see colors and backgrounds, not just text.
   */
  getViewportAnsi(): string[] {
    const lines: string[] = [];
    const buffer = this.xterm.buffer.active;
    for (let i = 0; i < this.xterm.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (!line) {
        lines.push("");
        continue;
      }
      lines.push(lineToAnsi(line));
    }
    return lines;
  }
  /** Scrollback + viewport with per-cell SGR re-emitted. */
  getScrollBufferAnsi(): string[] {
    const lines: string[] = [];
    const buffer = this.xterm.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? lineToAnsi(line) : "");
    }
    return lines;
  }

  getScrollBuffer(): string[] {
    const lines: string[] = [];
    const buffer = this.xterm.buffer.active;

    // Get all lines in the buffer (including scrollback)
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      } else {
        lines.push("");
      }
    }

    return lines;
  }

  /**
   * Clear the terminal viewport
   */
  clear(): void {
    this.xterm.clear();
  }

  /**
   * Reset the terminal completely
   */
  reset(): void {
    this.xterm.reset();
  }

  /**
   * Get cursor position
   */
  getCursorPosition(): { x: number; y: number } {
    const buffer = this.xterm.buffer.active;
    return {
      x: buffer.cursorX,
      y: buffer.cursorY,
    };
  }

  /** Wait for TUI's throttled render pipeline to settle. */
  async waitForRender(): Promise<void> {
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await this.flush();
  }
}
/** SGR escape for one cell's styling; empty string means default attrs. */
function cellSgr(cell: IBufferCell): string {
  const codes: string[] = [];
  if (cell.isBold()) codes.push("1");
  if (cell.isDim()) codes.push("2");
  if (cell.isItalic()) codes.push("3");
  if (cell.isUnderline()) codes.push("4");
  if (cell.isInverse()) codes.push("7");
  if (cell.isStrikethrough()) codes.push("9");
  const fg = colorCode(cell.getFgColor(), cell.getFgColorMode(), 30);
  if (fg) codes.push(fg);
  const bg = colorCode(cell.getBgColor(), cell.getBgColorMode(), 40);
  if (bg) codes.push(bg);
  return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/** Map xterm color (palette index or packed rgb) to an SGR parameter. */
function colorCode(color: number, mode: number, base: number): string | null {
  // xterm packs the color mode in bits 24-25: 0 = default, 1 = P16 palette,
  // 2 = P256 palette, 3 = RGB.
  const kind = mode >>> 24;
  if (kind === 1) {
    if (color < 8) return `${base + color}`;
    return `${base + 60 + color - 8}`;
  }
  if (kind === 2) return `${base + 8};5;${color}`;
  if (kind === 3) {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `${base + 8};2;${r};${g};${b}`;
  }
  return null;
}

/** One buffer row with SGR codes re-emitted between attribute runs. */
export function lineToAnsi(line: IBufferLine): string {
  let out = "";
  let current = "";
  let x = 0;
  while (x < line.length) {
    const cell = line.getCell(x);
    if (!cell) break;
    const sgr = cellSgr(cell);
    if (sgr !== current) {
      current = sgr;
      out += "\x1b[0m";
      out += sgr;
    }
    const width = cell.getWidth();
    if (width === 0) {
      // Zero-width cell (e.g. after a wide char): escape only, no glyph.
      out += cell.getChars();
      x += 1;
      continue;
    }
    out += cell.getChars() || " ";
    x += width;
  }
  if (current) out += "\x1b[0m";
  return out;
}

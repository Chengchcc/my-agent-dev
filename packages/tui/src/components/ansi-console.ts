import xterm from "@xterm/headless";
import type { Component } from "../tui.ts";
import { lineToAnsi } from "../virtual-terminal.ts";

const XtermTerminal = xterm.Terminal;

/** Live ANSI console pane backed by a headless xterm VT.
 *
 *  Feed it raw program output (`write`); it parses cursor control, colors,
 *  and screen addressing into a bounded virtual screen, and `render()`
 *  emits the visible rows as styled ANSI lines for the host TUI. When
 *  focused, `handleInput` forwards raw key bytes to `onInput` (the pty
 *  master); a lone Esc calls `onExitKey` instead (kill semantics).
 *
 *  This is the rendering half of an embedded console (run an interactive
 *  command inside a TUI without leaving it). Transport (pty bridge) and
 *  lifecycle live with the caller. */
export class AnsiConsole implements Component {
  private readonly vt: InstanceType<typeof XtermTerminal>;
  private dirty = true;
  private cached: string[] = [];
  private cachedWidth = -1;

  constructor(
    columns: number,
    private readonly rows: number,
    private readonly onInput: (data: string) => void,
    private readonly onExitKey: () => void,
    private readonly onRequestRender: () => void = () => {},
  ) {
    this.vt = new XtermTerminal({
      cols: columns,
      rows,
      disableStdin: true,
      allowProposedApi: true,
    });
  }

  /** Raw program output (ANSI allowed) into the virtual screen. */
  write(data: string): void {
    this.vt.write(data);
    this.dirty = true;
    this.onRequestRender();
  }

  /** Resolves after every queued write has been parsed into the buffer
   *  (xterm processes writes asynchronously). Await before render(). */
  flush(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.vt.write("", () => resolve());
    return promise;
  }

  render(width: number): string[] {
    if (this.dirty || this.cachedWidth !== width) {
      this.cached = [];
      const buffer = this.vt.buffer.active;
      for (let row = 0; row < this.rows; row++) {
        const line = buffer.getLine(buffer.viewportY + row);
        this.cached.push(line ? lineToAnsi(line) : "");
      }
      this.cachedWidth = width;
      this.dirty = false;
    }
    return this.cached.map((line) => line.slice(0, width));
  }

  handleInput(data: string): void {
    // A lone Esc terminates the console (pi semantics); escape sequences
    // (ESC followed by more bytes) are forwarded untouched.
    if (data === "\x1b") {
      this.onExitKey();
      return;
    }
    this.onInput(data);
  }

  invalidate(): void {
    this.dirty = true;
    this.cached = [];
  }
}

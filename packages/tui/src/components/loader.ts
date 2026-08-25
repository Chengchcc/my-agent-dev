import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
  /** Animation frames. Use an empty array to hide the indicator. */
  frames?: string[];
  /** Frame interval in milliseconds for animated indicators. */
  intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
  private frames = [...DEFAULT_FRAMES];
  private intervalMs = DEFAULT_INTERVAL_MS;
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private ui: TUI | null = null;
  private renderIndicatorVerbatim = false;
  private spinnerColorFn: (str: string) => string;
  private messageColorFn: (str: string) => string;
  private message: string = "Loading...";

  constructor(
    ui: TUI,
    spinnerColorFn: (str: string) => string,
    messageColorFn: (str: string) => string,
    message: string = "Loading...",
    indicator?: LoaderIndicatorOptions,
  ) {
    super("", 1, 0);
    this.ui = ui;
    this.spinnerColorFn = spinnerColorFn;
    this.messageColorFn = messageColorFn;
    this.message = message;
    this.setIndicator(indicator);
  }

  override render(width: number): string[] {
    // omp's Loader reserves a blank row above the spinner so the working
    // status does not sit flush against the transcript; add a trailing row
    // too so it does not crowd the editor's top border.
    return ["", ...super.render(width), ""];
  }

  start(): void {
    this.updateDisplay();
    this.restartAnimation();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  setMessage(message: string): void {
    if (message === this.message) return;
    this.message = message;
    this.updateDisplay();
  }

  setIndicator(indicator?: LoaderIndicatorOptions): void {
    this.renderIndicatorVerbatim = indicator !== undefined;
    this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
    this.intervalMs =
      indicator?.intervalMs && indicator.intervalMs > 0
        ? indicator.intervalMs
        : DEFAULT_INTERVAL_MS;
    this.currentFrame = 0;
    this.start();
  }

  private restartAnimation(): void {
    this.stop();
    if (this.frames.length <= 1) {
      return;
    }
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.updateDisplay();
    }, this.intervalMs);
  }

  /** Moving light sweep across the message (omp shimmer-lite). */
  private animateMessage(message: string): string {
    if (!message) return "";
    // Sweep a short accent band across the text; the rest stays in the
    // base message color so the line stays legible while it moves.
    const base = this.messageColorFn;
    const period = message.length + 4;
    const start = this.currentFrame % period;
    let out = "";
    for (let i = 0; i < message.length; i++) {
      const dist = Math.abs(i - start);
      if (dist < 1) {
        out += `\u001b[1m\u001b[36m${message[i]}\u001b[0m`;
      } else if (dist < 2) {
        out += `\u001b[36m${message[i]}\u001b[0m`;
      } else {
        out += base(message[i]);
      }
    }
    return out;
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame] ?? "";
    const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
    const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
    this.setText(`${indicator}${this.animateMessage(this.message)}`);
    if (this.ui) {
      this.ui.requestRender();
    }
  }
}

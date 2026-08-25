/**
 * Bordered output container with optional header and labelled sections.
 *
 * This is the unified framed-box primitive for tool cards and any future
 * rich result blocks. It replaces the ad-hoc Card + Text children hacks that
 * made each tool renderer re-implement its own border/background rules.
 */
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export type OutputBlockState = "pending" | "running" | "success" | "error" | "warning";

export interface OutputBlockSection {
  /** Rendered as a label bar: ├── label ─────┤ */
  label?: string;
  /** Draw a plain divider bar instead of (or in addition to) the label. */
  separator?: boolean;
  /** Body lines; each may contain ANSI codes. */
  lines: readonly string[];
}

export interface OutputBlockOptions {
  /** Title-bar text (usually from renderToolHeader). */
  header?: string;
  /** Trailing meta appended to the header bar. */
  headerMeta?: string;
  state: OutputBlockState;
  sections: readonly OutputBlockSection[];
  width: number;
  /** Override the state-derived border color (raw ANSI SGR). */
  borderColor?: string;
  /** Whole-block background tint. */
  bg?: (line: string) => string;
  applyBg?: boolean;
  contentPaddingLeft?: number;
  contentPaddingRight?: number;
}

/** Default border colors, keyed by state (omp-ish semantics). */
const STATE_BORDER: Record<OutputBlockState, string> = {
  pending: "\x1b[38;5;33m",
  running: "\x1b[38;5;33m",
  success: "\x1b[38;5;8m",
  error: "\x1b[38;5;31m",
  warning: "\x1b[38;5;11m",
};

function normalizePadding(value: number | undefined): number {
  return value === undefined ? 1 : Math.max(0, Math.trunc(value));
}

/** Inner content width for a given outer width and symmetric padding. */
export function outputBlockContentWidth(
  width: number,
  contentPaddingLeft?: number,
  contentPaddingRight?: number,
): number {
  const left = normalizePadding(contentPaddingLeft);
  const right = normalizePadding(contentPaddingRight ?? left);
  return Math.max(1, width - 2 - left - right);
}

/** Build a titled header bar:  ┌─ title ─────────┐ */
function renderHeaderBar(
  leftChar: string,
  rightChar: string,
  label: string | undefined,
  meta: string | undefined,
  width: number,
  border: (s: string) => string,
): string {
  const left = leftChar + "─".repeat(3);
  const right = rightChar;
  const labelText = label === undefined ? "" : ` ${label}${meta ? ` · ${meta}` : ""} `;
  const labelWidth = visibleWidth(labelText);
  const fill = Math.max(0, width - visibleWidth(left) - labelWidth - visibleWidth(right));
  return `${border(left)}${labelText}${border("─".repeat(fill))}${border(right)}`;
}

/** Build a plain divider/bar:  ├─────────────────┤ */
function renderBar(
  leftChar: string,
  rightChar: string,
  width: number,
  border: (s: string) => string,
): string {
  const fill = Math.max(0, width - 2);
  return `${border(leftChar)}${border("─".repeat(fill))}${border(rightChar)}`;
}

/** Build the bottom bar:  └─────────────────┘ */
function renderBottomBar(
  leftChar: string,
  rightChar: string,
  width: number,
  border: (s: string) => string,
): string {
  return renderBar(leftChar, rightChar, width, border);
}

export function renderOutputBlock(options: OutputBlockOptions): string[] {
  const { header, headerMeta, state, sections, width } = options;
  const borderColor = options.borderColor ?? STATE_BORDER[state];
  const border = (s: string): string => `${borderColor}${s}\x1b[0m`;
  const bgFn = options.bg;
  const applyBg = options.applyBg !== false && bgFn !== undefined;
  const stabilize = (line: string): string => {
    if (!applyBg || bgFn === undefined) return line;
    return applyBackgroundToLine(line, width, bgFn);
  };

  const contentLeft = normalizePadding(options.contentPaddingLeft);
  const contentRight = normalizePadding(options.contentPaddingRight ?? contentLeft);
  const contentWidth = outputBlockContentWidth(width, contentLeft, contentRight);

  const lines: string[] = [];
  const pushBar = (left: string, right: string, label?: string, meta?: string): void => {
    lines.push(stabilize(renderHeaderBar(left, right, label, meta, width, border)));
  };

  pushBar("┌", "┐", header, headerMeta);

  const normalizedSections = sections.length > 0 ? sections : [{ lines: [] }];
  for (let i = 0; i < normalizedSections.length; i++) {
    const section = normalizedSections[i]!;
    if (section.label !== undefined) {
      pushBar("├", "┤", section.label);
    } else if (section.separator && i > 0) {
      lines.push(stabilize(renderBar("├", "┤", width, border)));
    }

    for (const rawLine of section.lines) {
      for (const line of rawLine.split("\n")) {
        const trimmed = line.trimEnd();
        const wrapped = wrapTextWithAnsi(trimmed, contentWidth);
        for (const w of wrapped) {
          const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(w)));
          const inner = `${" ".repeat(contentLeft)}${w}${" ".repeat(contentRight)}${pad}`;
          const row = `${border("│")}${inner}${border("│")}`;
          lines.push(stabilize(row));
        }
      }
    }
  }

  lines.push(stabilize(renderBottomBar("└", "┘", width, border)));
  return lines;
}

/**
 * Cached wrapper around renderOutputBlock.
 *
 * Tool blocks are re-rendered every frame while the transcript is live. The
 * key hashes every field that materially changes the produced lines, so a
 * stable block avoids re-running visibleWidth / wrapTextWithAnsi on every
 * keystroke.
 */
export class CachedOutputBlock {
  private cachedKey: string | undefined;
  private cachedLines: readonly string[] | undefined;

  render(options: OutputBlockOptions): readonly string[] {
    const key = this.buildKey(options);
    if (this.cachedKey === key) return this.cachedLines ?? [];
    const lines = renderOutputBlock(options);
    this.cachedKey = key;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedLines = undefined;
  }

  private buildKey(options: OutputBlockOptions): string {
    const parts: unknown[] = [
      options.width,
      options.state,
      options.borderColor,
      options.header,
      options.headerMeta,
      options.contentPaddingLeft,
      options.contentPaddingRight,
      options.applyBg,
      // bg is a function reference; invalidate() forces rebuild on change.
      options.bg === undefined ? "no-bg" : "bg",
    ];
    for (const section of options.sections) {
      parts.push(section.label, section.separator === true ? 1 : 0);
      parts.push(...section.lines);
    }
    return JSON.stringify(parts);
  }
}

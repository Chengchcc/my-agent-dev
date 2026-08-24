import type { Component } from "../tui.ts";
import { applyBackgroundToLine } from "../utils.ts";
import { Box } from "./box.ts";

export interface CardBorder {
  /** Border color function (optional; default reset). */
  color?: (s: string) => string;
}

export interface CardOptions {
  /** Horizontal padding (default 1). */
  paddingX?: number;
  /** Top/bottom padding rows (default 1 — omp card breathing). */
  paddingY?: number;
  /** Whole-card background tint (e.g. toolPendingBg/SuccessBg/ErrorBg). */
  bg?: (s: string) => string;
  /** Optional box-drawing border. */
  border?: CardBorder;
}

/**
 * Card = a padded, background-tinted rectangle for header + body lines.
 * Mirrors omp's generic tool card (bg tint + optional border). The wrapped
 * Box already fills the full width with bg; border is drawn outside it with
 * the same tint so a bordered card stays one continuous rectangle.
 */
export class Card implements Component {
  private box: Box;
  private bgFn?: (s: string) => string;
  private border?: CardBorder;

  constructor(children: Component[] = [], opts: CardOptions = {}) {
    this.bgFn = opts.bg;
    this.border = opts.border;
    this.box = new Box(opts.paddingX ?? 1, opts.paddingY ?? 1, opts.bg);
    for (const child of children) this.box.addChild(child);
  }

  addChild(child: Component): void {
    this.box.addChild(child);
  }

  clear(): void {
    this.box.clear();
  }

  setBg(bg?: (s: string) => string): void {
    this.bgFn = bg;
    this.box.setBgFn(bg);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    if (!this.border) return this.box.render(width);
    const inner = this.box.render(Math.max(1, width - 2));
    if (inner.length === 0) return [];
    const frame = (line: string, left: string, right: string): string => {
      const styled = this.border?.color ?? ((s: string) => s);
      const framed = `${styled(left)}${line}${styled(right)}`;
      return this.bgFn ? applyBackgroundToLine(framed, width, this.bgFn) : framed;
    };
    const top = frame(`${"─".repeat(Math.max(0, width - 2))}`, "┌", "┐");
    const bottom = frame(`${"─".repeat(Math.max(0, width - 2))}`, "└", "┘");
    const body = inner.map((line) => frame(line, "│", "│"));
    return [top, ...body, bottom];
  }
}

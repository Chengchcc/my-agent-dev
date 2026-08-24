import type { Component } from "../tui.ts";
import { Box } from "./box.ts";

export interface CardOptions {
  /** Horizontal padding (default 1). */
  paddingX?: number;
  /** Top/bottom padding rows (default 1 — omp card breathing). */
  paddingY?: number;
  /** Whole-card background tint (e.g. toolPendingBg/SuccessBg/ErrorBg). */
  bg?: (s: string) => string;
}

/**
 * Card = a padded, background-tinted rectangle for header + body lines.
 * v1 mirrors omp's generic tool card: a contiguous tinted block with
 * horizontal/top/bottom padding (Box already fills the full width with bg).
 * Border/JSON-tree rendering is intentionally deferred to P2.
 */
export class Card implements Component {
  private box: Box;

  constructor(children: Component[] = [], opts: CardOptions = {}) {
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
    this.box.setBgFn(bg);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }
}

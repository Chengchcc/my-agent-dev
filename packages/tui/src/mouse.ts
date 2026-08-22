/** SGR mouse report parsing (`\x1b[<button;col;rowM` / `…m`).
 *
 * Mouse tracking (modes 1000 + 1006) is enabled by the APPLICATION (oma
 * enables it for the whole session so the wheel can scroll the transcript —
 * our TUI keeps no native-scrollback copy of history). Consumers get 0-based
 * col/row for direct indexing into rendered lines.
 *
 * ponytail: wheel-only consumer for now; click/hover routing (pi's
 * SelectListMouseTarget helpers) can be ported when an overlay needs it.
 *
 * Ported from pi's packages/tui/src/mouse.ts. */

/** A decoded SGR mouse report. */
export interface SgrMouseEvent {
  /** Raw button code (bit 32 = motion, bit 64 = wheel, low bits = button). */
  button: number;
  /** 0-based column of the event. */
  col: number;
  /** 0-based row of the event. */
  row: number;
  /** True for a release report (`m` suffix). */
  release: boolean;
  /** Wheel direction: -1 up, 1 down, null when not a wheel event. */
  wheel: -1 | 1 | null;
  /** True when the pointer moved (hover or drag) rather than clicked. */
  motion: boolean;
  /** True for a left-button press (not motion, not release, not wheel). */
  leftClick: boolean;
}

/** Decode an SGR mouse report, or return null when `data` is not one.
 *  Callers on hot keypress paths should pre-check `data.startsWith("\x1b[<")`
 *  before paying for the regex. */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  const col = Number(match[2]) - 1;
  const row = Number(match[3]) - 1;
  const release = match[4] === "m";
  const wheel = button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
  const motion = (button & 32) !== 0 && wheel === null;
  const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
  return { button, col, row, release, wheel, motion, leftClick };
}

/** Handler invoked with a decoded SGR event; returning `false` reports unhandled. */
export type SgrMouseHandler = (event: SgrMouseEvent) => boolean | undefined;

/** Decode an SGR mouse report and forward it to `handler`. Returns `false`
 *  when `data` is not an SGR mouse report (or fails to parse), so callers can
 *  fall through to other input handling. Centralizes the repeated
 *  `data.startsWith("\x1b[<")` + `parseSgrMouse()` pattern. */
export function routeSgrMouseInput(data: string, handler: SgrMouseHandler): boolean {
  if (!data.startsWith("\x1b[<")) return false;
  const event = parseSgrMouse(data);
  if (!event) return false;
  return handler(event) !== false;
}

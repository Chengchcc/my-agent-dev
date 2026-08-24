/**
 * Minimal omp-style status bar renderer (powerline chip + semantic colors).
 * Pure ANSI functions, no component state. Keeping this in packages/tui lets
 * both the bottom status line and (optionally) the header reuse it.
 */

export interface StatusSegment {
  text: string;
  /** Render as a filled powerline chip (bg + ◀ ▶) instead of plain text. */
  chip?: boolean;
  /** Foreground ANSI for plain segments (default reset). */
  fg?: string;
  /** Background ANSI for chip segments (e.g. `\x1b[48;5;25m`). */
  bg?: string;
}

/** One powerline chip: ◀bg label bg▶ using the same color for arrows and fill. */
export function chip(text: string, bgAnsi: string): string {
  const fg = bgAnsi.replace("\x1b[48;", "\x1b[38;");
  return `${fg}◀${bgAnsi}\x1b[1m ${text} \x1b[22m\x1b[0m${fg}▶`;
}

/** Join a segment array with the thin smoke separator; chips get their own fill. */
export function renderStatusBar(segs: readonly StatusSegment[]): string {
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!s.text) continue;
    if (i > 0) out.push(`\x1b[38;5;8m ┆ \x1b[0m`);
    if (s.chip && s.bg) {
      out.push(chip(s.text, s.bg));
    } else {
      out.push(`${s.fg ?? "\x1b[0m"}${s.text}\x1b[0m`);
    }
  }
  return out.join("");
}

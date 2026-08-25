/**
 * Mermaid ASCII rendering helper (omp mermaid-cache equivalent).
 *
 * The vendored `beautiful-mermaid` fork supports a `direction` override, so a
 * wide diagram can be re-laid-out top-down (or left-right) to fit a terminal
 * width. We memoize renders by source + options + direction and only choose a
 * forced direction when the base layout overflows the requested maxWidth.
 */
import { type AsciiRenderOptions, renderMermaidASCII } from "./vendor/mermaid-ascii/index.ts";

export type { AsciiRenderOptions as MermaidAsciiRenderOptions };

/** Memoized renders (and failures), keyed on source + options + direction. */
const cache = new Map<string, string | null>();

/** Widest rendered row in display columns (Bun wcwidth-style). */
function asciiDisplayWidth(ascii: string): number {
  let max = 0;
  for (const line of ascii.split("\n")) {
    const width = Bun.stringWidth(line);
    if (width > max) max = width;
  }
  return max;
}

function renderVariant(
  source: string,
  baseOptions: AsciiRenderOptions,
  baseKey: string,
  direction: "TD" | "LR" | null,
): string | null {
  const key = `${baseKey}\x00${direction ?? ""}\x00${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const options: AsciiRenderOptions = direction ? { ...baseOptions, direction } : baseOptions;
  const ascii = renderMermaidAsciiSafe(source, options);
  cache.set(key, ascii);
  return ascii;
}

export function renderMermaidAsciiSafe(
  source: string,
  options?: AsciiRenderOptions,
): string | null {
  try {
    return renderMermaidASCII(source, options);
  } catch {
    return null;
  }
}

export interface MermaidResolveOptions extends AsciiRenderOptions {
  /** Maximum display width (terminal columns) the diagram should occupy. */
  maxWidth?: number;
}

/**
 * Resolve mermaid ASCII for a fenced block.
 * Returns null on failure, memoizing failures to avoid repeated work.
 */
export function resolveMermaidAscii(
  source: string,
  options?: MermaidResolveOptions,
): string | null {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;

  const { maxWidth, ...rest } = options ?? {};
  const baseOptions: AsciiRenderOptions = { colorMode: "none", ...rest };
  const baseKey = JSON.stringify(baseOptions);

  const base = renderVariant(normalized, baseOptions, baseKey, null);
  if (base === null) return null;
  if (maxWidth === undefined) return base;

  let best = base;
  let bestWidth = asciiDisplayWidth(base);
  if (bestWidth <= maxWidth) return base;

  // As-authored layout overflows. Render both forced orientations and keep the
  // narrowest; clipping at the call site handles any residual overflow.
  for (const direction of ["TD", "LR"] as const) {
    const variant = renderVariant(normalized, baseOptions, baseKey, direction);
    if (variant === null) continue;
    const variantWidth = asciiDisplayWidth(variant);
    if (variantWidth < bestWidth) {
      best = variant;
      bestWidth = variantWidth;
    }
  }
  return best;
}

/** Clear the mermaid cache (used on session reset). */
export function clearMermaidCache(): void {
  cache.clear();
}

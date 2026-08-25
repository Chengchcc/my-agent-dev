import type { DefaultTextStyle, EditorTheme, MarkdownTheme } from "@chengchenccc/tui";
import { applyBackgroundToLine, truncateToWidth } from "@chengchenccc/tui";

export const MAX_TOOL_ARGS = 200;
export const MAX_TOOL_DETAIL = 8_000;
export const MAX_DIFF_LINES = 6;

/** Compact single-line JSON, truncated with an ellipsis marker. */
export function compactJson(value: unknown, max: number): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** Multi-line pretty JSON, truncated at MAX_TOOL_DETAIL with an ellipsis. */
export function prettyJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  return json.length > MAX_TOOL_DETAIL ? `${json.slice(0, MAX_TOOL_DETAIL)}…` : json;
}

/** Collapsed tool-result summary: prefer result.content as a human
 *  sentence, keeping the exit marker; fall back to compact JSON only
 *  when content is not a string. */
export function summarizeResult(result: Readonly<Record<string, unknown>>): string {
  const content = result.content;
  if (typeof content === "string") {
    const lines = content
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const isError = result.isError === true || result.error !== undefined;
    // Success: strip the `[exit: 0]` notice (omp's stripExitCodeNotice) so
    // the line stays human; error keeps a red exit marker (renderTool colors it).
    const contentLines = isError ? lines : lines.filter((l) => !/^\[exit: \d+\]$/.test(l));
    if (contentLines.length > 0) {
      const first = contentLines[0]!;
      const exit = isError ? lines.find((l) => /^\[exit: \d+\]$/.test(l)) : undefined;
      const summary = exit && exit !== first ? `${first} · ${exit}` : first;
      const remaining = contentLines.filter((l) => l !== first && l !== exit).length;
      const suffix =
        remaining > 0 ? ` (+${remaining} line${remaining === 1 ? "" : "s"}, ctrl+o)` : "";
      const base = summary.length > MAX_TOOL_ARGS ? `${summary.slice(0, MAX_TOOL_ARGS)}…` : summary;
      return `${base}${suffix}`;
    }
    return "";
  }
  const json = JSON.stringify(result) ?? "";
  if (json.length <= MAX_TOOL_ARGS) return json;
  let firstLine = json;
  for (const value of Object.values(result)) {
    if (typeof value === "string" && value.trim()) {
      firstLine = value.trim().split("\n", 1)[0] ?? value;
      break;
    }
  }
  if (firstLine.length > MAX_TOOL_ARGS) {
    firstLine = `${firstLine.slice(0, MAX_TOOL_ARGS)}…`;
  }
  return `${firstLine} (+${json.length - firstLine.length} chars, ctrl+o)`;
}

/** Pi-style collapsed arg summaries: a human sentence per common tool
 *  (bash's `$ cmd`, read's `path:a-b`), falling back to compact JSON. */
export const TOOL_ARG_SUMMARIES: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (i) => {
    const command = typeof i.command === "string" ? i.command : "";
    const timeout =
      typeof i.timeout === "number" ? ` (timeout ${Math.round(i.timeout / 1000)}s)` : "";
    return `$ ${command}${timeout}`;
  },
  read: (i) => {
    const path = typeof i.path === "string" ? i.path : "";
    if (typeof i.offset === "number" && typeof i.limit === "number") {
      return `${path}:${i.offset}-${i.offset + i.limit - 1}`;
    }
    return path;
  },
  write: (i) => (typeof i.path === "string" ? i.path : ""),
  edit: (i) => (typeof i.path === "string" ? i.path : ""),
  grep: (i) => {
    const pattern = typeof i.pattern === "string" ? i.pattern : "";
    const path = typeof i.path === "string" ? ` ${i.path}` : "";
    return `${pattern}${path}`;
  },
  glob: (i) => (typeof i.pattern === "string" ? i.pattern : ""),
};

export function summarizeToolArgs(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const summarize = TOOL_ARG_SUMMARIES[toolName];
  if (summarize) {
    const summary = summarize(input);
    if (summary.trim()) return summary;
  }
  return compactJson(input, MAX_TOOL_ARGS);
}
export const EDITOR_THEME: EditorTheme = {
  borderColor: (s) => `\u001b[2m${s}\u001b[0m`,
  selectList: {
    selectedPrefix: (s) => `\u001b[36m${s}\u001b[0m`,
    selectedText: (s) => `\u001b[1m${s}\u001b[0m`,
    description: (s) => `\u001b[2m${s}\u001b[0m`,
    scrollInfo: (s) => `\u001b[2m${s}\u001b[0m`,
    noMatch: (s) => `\u001b[2m${s}\u001b[0m`,
  },
};

/** Compact relative age for the session picker's label column. */
export function relativeTime(modifiedAt: number): string {
  const minutes = Math.floor((Date.now() - modifiedAt) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** Markdown theme for assistant output: plain readable text with ANSI
 *  emphasis — bold/italic/links/code styled, headings bold, no colors
 *  beyond dim (pi renders through its theme; oma keeps it monochrome+dim
 *  so the cyan user bubble stays the only saturated element). */
export const MARKDOWN_THEME: MarkdownTheme = {
  heading: (s) => `\u001b[1m${s}\u001b[0m`,
  link: (s) => `\u001b[4m${s}\u001b[0m`,
  linkUrl: (s) => `\u001b[2m${s}\u001b[0m`,
  code: (s) => `\u001b[36m${s}\u001b[0m`,
  codeBlock: (s) => `\u001b[36m${s}\u001b[0m`,
  codeBlockBorder: (s) => `\u001b[2m${s}\u001b[0m`,
  quote: (s) => `\u001b[2m${s}\u001b[0m`,
  quoteBorder: (s) => `\u001b[2m${s}\u001b[0m`,
  hr: (s) => `\u001b[2m${s}\u001b[0m`,
  listBullet: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  italic: (s) => `\u001b[3m${s}\u001b[0m`,
  strikethrough: (s) => `\u001b[9m${s}\u001b[0m`,
  underline: (s) => `\u001b[4m${s}\u001b[0m`,
};

/** User bubble: markdown text on a deep-blue background tint with cyan
 *  text (pi's UserMessageComponent look). */
export const USER_TEXT_STYLE: DefaultTextStyle = {
  color: (s) => `\u001b[36m${s}\u001b[0m`,
  bgColor: (s) => `\u001b[48;5;234m${s}\u001b[0m`,
};

/** Compact token count for the header: 12k / 200k. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

/** Compact model meta line (pi's ModelBrowser columns): display name,
 *  context window, $in/out per-million cost (free when both legs are zero),
 *  current-model mark, and an over-context warning when the session's
 *  estimated tokens exceed the model's window. */
export function formatModelMeta(
  model: {
    displayName: string;
    contextWindow: number;
    cost?: { input: number; output: number };
  },
  opts: { current?: boolean; contextTokens?: number } = {},
): string {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  const cost = input <= 0 && output <= 0 ? "free" : `$${input}/${output}`;
  const parts = [model.displayName, `ctx ${formatTokens(model.contextWindow)}`, cost];
  if (opts.current) parts.push("current");
  if (opts.contextTokens !== undefined && model.contextWindow < opts.contextTokens) {
    parts.push("over current context!");
  }
  return parts.join(" · ");
}

export const OVERLAY_BG = (s: string): string => `\u001b[48;5;235m${s}\u001b[0m`;

/** Pad + frame overlay lines so they cover the underlying transcript
 *  (a plain Container's unshaped whitespace lets the base text bleed
 *  through). */
export function overlayLines(lines: readonly string[], width: number): string[] {
  const innerWidth = Math.max(1, width - 2);
  return lines.map((line) => {
    const content = truncateToWidth(line, innerWidth, "", true);
    return `\u001b[36m\u2502\u001b[0m${applyBackgroundToLine(content, innerWidth, OVERLAY_BG)}\u001b[36m\u2502\u001b[0m`;
  });
}

/** Overlay root for the session picker: renders title + list and routes
 *  key input to the list (a plain Container has no handleInput). */
/** Clean a session title for the header line: strip markdown heading
 *  markers/whitespace, collapse whitespace, cap at 32 chars. */
export function cleanHeaderTitle(title: string): string {
  const cleaned = title
    .replace(/^[#>*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const truncated = cleaned.length > 32 ? `${cleaned.slice(0, 32)}…` : cleaned;
  return ` — ${truncated}`;
}

/** Compact git branch + dirty count for the idle status line. */
export function gitStatus(workspaceRoot: string): string {
  try {
    const branchResult = Bun.spawnSync([
      "git",
      "-C",
      workspaceRoot,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (branchResult.exitCode !== 0) return "";
    const branch = branchResult.stdout.toString().trim();
    if (!branch) return "";
    const porcelain = Bun.spawnSync(["git", "-C", workspaceRoot, "status", "--porcelain"]);
    if (porcelain.exitCode !== 0) return branch;
    const changes = porcelain.stdout.toString().split("\n").filter(Boolean).length;
    return changes > 0 ? `${branch}+${changes}` : branch;
  } catch {
    return "";
  }
}

/** Shorten the workspace path for display (~/... when under HOME). */
export function formatWorkspace(root: string): string {
  const home = process.env.HOME;
  if (home && (root === home || root.startsWith(`${home}/`))) {
    return root === home ? "~" : `~${root.slice(home.length)}`;
  }
  return root;
}

/** Branch cyan, dirty count ember (omp gitClean/gitDirty colors). */
export function renderGitSegment(git: string): string {
  if (!git) return "";
  const plus = git.indexOf("+");
  if (plus === -1) return `\u001b[38;5;42m${git}\u001b[0m`;
  return `\u001b[38;5;39m${git.slice(0, plus)}\u001b[0m\u001b[38;5;172m${git.slice(plus)}\u001b[0m`;
}

/** Threshold color for context percent (omp contextPct). */
export function contextColor(ctx: string): string {
  const m = ctx.match(/(\d+)%/);
  const pct = m ? Number(m[1]) : 0;
  if (pct >= 90) return "\u001b[38;5;196m";
  if (pct >= 70) return "\u001b[38;5;172m";
  return "\u001b[2m";
}

/** One-time welcome easter eggs, rotated per session (omp welcome tip). */
export const WELCOME_TIPS: readonly string[] = [
  "Tip: press ctrl+t to expand thinking, ctrl+o for tool detail",
  "Tip: /mcp test <name> checks a configured MCP server",
  "Tip: /resume lists saved sessions; /session shows the current id",
  "Tip: /workflow runs a script with subagents",
  "Tip: /exit twice quits; /help lists all commands",
];

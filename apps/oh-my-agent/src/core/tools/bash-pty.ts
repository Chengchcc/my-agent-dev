/** Shared PTY helpers for bash-tool pty mode and the TUI pty console. */

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a command so it runs with a real pseudo-terminal (script -e keeps
 *  the exit code). util-linux (Linux) and BSD script (macOS) differ.
 *  Returns null when no script binary exists. */
export function ptyWrap(command: string): string | null {
  const script = Bun.which("script");
  if (!script) return null;
  if (process.platform === "darwin") {
    return `${script} -q /dev/null ${shellQuote(command)}`;
  }
  return `${script} -qec ${shellQuote(command)} /dev/null`;
}

/** script-bridge pty with a fixed window size: stty runs INSIDE the pty
 *  before the command, sizing it for TUI programs (no live resize). */
export function ptyConsoleCommand(command: string, cols: number, rows: number): string | null {
  const wrapped = ptyWrap(command);
  if (wrapped === null) return null;
  return `stty rows ${rows} cols ${cols}; ${wrapped}`;
}

/** Extra env a pty child needs (the plain bash env has no TERM). */
export function withPtyEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, TERM: "xterm-256color" };
}

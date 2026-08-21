/** Process-tree teardown helper shared by MCP stdio clients.

 *  The MCP SDK's StdioClientTransport.close() only SIGKILLs its direct
 *  child. npm/npx-style servers spawn grandchildren (npm -> sh -> node)
 *  that inherit the stdio pipes; once the direct child dies they are
 *  reparented to init, so a post-close pgrep -P walk cannot find them.
 *  Collect the whole descendant tree BEFORE closing, then SIGKILL every
 *  pid after the SDK close. */
export function collectDescendants(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const out = Bun.spawnSync(["pgrep", "-P", String(parent)], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    if (!out) continue;
    for (const line of out.split("\n")) {
      const child = Number(line);
      if (child > 0) {
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

/** Collect pid + descendants, then SIGKILL them all (best-effort). */
export function killProcessTree(pid: number): void {
  const tree = [pid, ...collectDescendants(pid)];
  for (const target of tree) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Minimal OMA_DEBUG=1 diagnostic logger. Writes one line per
 *  lifecycle milestone to stderr; no-op unless the env var is exactly "1".
 *  Never logs message bodies, tool inputs, prompts or secrets - only
 *  stage names, ids, counts and statuses. The child inherits the env, so
 *  the same switch lights up backend, adapter, child RPC and loop logs. */
const DEBUG_ENABLED = process.env.OMA_DEBUG === "1";

export function debugLog(tag: string, message: string): void {
  if (!DEBUG_ENABLED) return;
  process.stderr.write(`[${tag}] ${message}\n`);
}

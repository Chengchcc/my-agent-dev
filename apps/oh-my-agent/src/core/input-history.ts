import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./session-file.js";

/** Persistent prompt history (pi's HistoryStorage, lazy form): a plain JSON
 * array instead of SQLite+FTS — a few hundred short strings do not need an
 * index, and substring filtering covers the search overlay fine.
 * ponytail: global across workspaces (pi tracks cwd); scope per-cwd when
 * cross-workspace noise actually bothers anyone. */

const CAP = 500;

function historyPath(): string {
  return join(agentDir(), "history.json");
}

/** Newest first. Missing/corrupt file yields []. */
export function loadInputHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(historyPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Pure insert: newest first, consecutive duplicates skipped, older exact
 *  duplicates hoisted (removed from their old position), capped at CAP.
 *  Returns the SAME array reference when nothing changed (skip-write signal). */
export function appendInputHistory(existing: readonly string[], prompt: string): readonly string[] {
  const trimmed = prompt.trim();
  if (!trimmed) return existing;
  if (existing[0] === trimmed) return existing;
  const rest = existing.filter((p) => p !== trimmed);
  const next = [trimmed, ...rest];
  return next.length > CAP ? next.slice(0, CAP) : next;
}

export function saveInputHistory(entries: readonly string[]): void {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(historyPath(), JSON.stringify(entries), "utf8");
}

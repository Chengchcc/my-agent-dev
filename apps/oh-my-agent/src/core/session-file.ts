import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The oma's own session store (ADR 0003 decision 6): parentId-
 *  chained JSONL, same shape family as pi/omp. The CLI owns its session;
 *  the product stores only the session id (branch.cliSessionRef).
 *
 *  Typing: the wire contract (agent-backend transport) deliberately models
 *  messages as `Record<string, unknown>` - the durable file keeps that same
 *  wire-loose shape. Strict `Message` typing is the runtime's job, applied
 *  where the loop consumes them, so this module performs no type bypass. */

/** Oma agent root (pi's getAgentDir): ~/.oma by default, overridable with
 *  OMA_CODING_AGENT_DIR (pi's PI_CODING_AGENT_DIR). Everything under it —
 *  sessions today — follows the override. */
export function agentDir(): string {
  return process.env.OMA_CODING_AGENT_DIR ?? join(homedir(), ".oma");
}

/** Sessions root: <agentDir>/sessions. */
export function sessionsRoot(): string {
  return join(agentDir(), "sessions");
}

/** Session directory for a specific workspace root (pi's per-cwd dir). */
export function sessionDirFor(workspaceRoot: string): string {
  const safePath = `--${workspaceRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot(), safePath);
}

/** Default session store, isolated per workspace (pi's model): sessions
 *  live under <agentDir>/sessions/--<cwd-encoded>--/ so different
 *  workspaces never see each other's sessions. OMA_SESSION_DIR overrides
 *  the WHOLE store as a flat directory (pi's PI_CODING_AGENT_SESSION_DIR). */
export function sessionDir(): string {
  return process.env.OMA_SESSION_DIR ?? sessionDirFor(process.cwd());
}

export function sessionPath(id: string): string {
  return join(sessionDir(), `${id}.jsonl`);
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Load the transcript messages of a session file (wire-loose shape).
 *  Missing/corrupt files yield [] (the caller falls back to a fresh
 *  session). A compaction event REPLACES everything recorded before it:
 *  the summary becomes one context message, later turns stay live — so a
 *  resumed session does not re-inflate the context it already compacted. */
export function loadSessionMessages(
  id: string,
  dir: string = sessionDir(),
): Record<string, unknown>[] {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return [];
  const messages: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      // The one unavoidable boundary: JSON.parse yields unknown; the typed
      // cast pins OUR durable format's event shape.
      const evt = JSON.parse(line) as {
        type?: string;
        message?: Record<string, unknown>;
        summary?: string;
      };
      if (evt.type === "message" && evt.message?.role) messages.push(evt.message);
      else if (evt.type === "compaction" && typeof evt.summary === "string") {
        messages.length = 0;
        messages.push({
          role: "user",
          text: `<previous_session_summary>\n${evt.summary}\n</previous_session_summary>`,
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return messages;
}

export interface SessionSummary {
  readonly id: string;
  readonly modifiedAt: number;
  /** Auto title from the last completed run's title event, when present. */
  readonly title?: string;
  /** First user message text (truncated), fallback when no title exists. */
  readonly preview: string;
  /** Workspace root the session was created in (from the file header's
   *  cwd field); present for cross-workspace listings. */
  readonly workspace?: string;
  /** Present when this session was forked from another: the parent id
   *  (pi's fork dot in the session selector). */
  readonly forkOf?: string;
}

interface SessionFileEvent {
  type?: string;
  title?: string;
  cwd?: string;
  message?: { role?: string; text?: string };
  parentId?: string;
}

/** Scan one session directory (all *.jsonl) into summaries. */
function scanSessionDir(dir: string, workspace?: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const summaries: SessionSummary[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    const path = join(dir, entry);
    let preview = "";
    let title: string | undefined;
    let headerCwd: string | undefined;
    let forkOf: string | undefined;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        // Durable-format boundary: JSON lines are our own event shape.
        const evt = JSON.parse(line) as SessionFileEvent;
        if (evt.type === "session" && typeof evt.cwd === "string") {
          headerCwd = evt.cwd;
          continue;
        }
        if (evt.type === "title" && typeof evt.title === "string") {
          title = evt.title;
          continue;
        }
        if (evt.type === "fork_of" && typeof evt.parentId === "string") {
          forkOf = evt.parentId;
          continue;
        }
        if (!preview && evt.type === "message" && evt.message?.role === "user") {
          preview = String(evt.message.text ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 60);
        }
      }
    } catch {
      /* corrupt file: listed with an empty preview */
    }
    const summary: {
      id: string;
      modifiedAt: number;
      preview: string;
      title?: string;
      workspace?: string;
      forkOf?: string;
    } = { id, modifiedAt: statSync(path).mtimeMs, preview };
    if (title !== undefined) summary.title = title;
    if (workspace !== undefined) summary.workspace = workspace;
    else if (headerCwd !== undefined) summary.workspace = headerCwd;
    if (forkOf !== undefined) summary.forkOf = forkOf;
    summaries.push(summary);
  }
  return summaries;
}

/** Session files of the current workspace, newest first. */
export function listSessions(): SessionSummary[] {
  return scanSessionDir(sessionDir());
}

/** Session files across EVERY workspace, newest first. Covers both the
 *  default layout (<agentDir>/sessions/--<cwd>--/*.jsonl) and an explicit
 *  flat OMA_SESSION_DIR. Each summary carries the workspace it belongs to
 *  (pi's session selector "all" scope). */
export function listAllSessions(): SessionSummary[] {
  // Explicit flat OMA_SESSION_DIR: sessions live at the root itself.
  if (process.env.OMA_SESSION_DIR) return scanSessionDir(process.env.OMA_SESSION_DIR);
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const summaries: SessionSummary[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("--")) continue; // per-workspace dirs only
    summaries.push(...scanSessionDir(join(root, entry)));
  }
  return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Append a title event: the session's display title, auto-generated by the
 *  loop after each completed run. Last one wins in listings. Also the
 *  primitive for /rename: appending a new title overrides the display. */
export function appendSessionTitle(id: string, title: string, dir: string = sessionDir()): void {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "title",
      timestamp: new Date().toISOString(),
      title,
    })}\n`,
  );
}

/** Delete a session file. Returns false when it did not exist. */
export function deleteSession(id: string, dir: string = sessionDir()): boolean {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Rename a session's display title (last-wins title event). Returns false
 *  when the session file does not exist. */
export function renameSession(id: string, title: string, dir: string = sessionDir()): boolean {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return false;
  appendSessionTitle(id, title, dir);
  return true;
}
/** Append a compaction event: records that the run compacted everything
 *  recorded so far in this file into `summary`. Must be called AFTER the
 *  turn's messages are appended. */
export function appendSessionCompaction(
  id: string,
  summary: string,
  dir: string = sessionDir(),
): void {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return;
  appendFileSync(
    path,
    `${JSON.stringify({
      type: "compaction",
      timestamp: new Date().toISOString(),
      summary,
    })}\n`,
  );
}

export interface SessionBranchNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: string;
  readonly text: string;
  readonly depth: number;
  /** 1-based user-message ordinal when this node is a user message (fork anchor). */
  readonly ordinal?: number;
}

/** Read the durable event tree of one session as parentId-chained message
 *  nodes (used by the TUI branch-tree fork overlay). Only message events
 *  carry an id; corrupt lines are skipped. */
export function loadSessionBranchNodes(
  id: string,
  dir: string = sessionDir(),
): SessionBranchNode[] {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const parents = new Map<string, string | null>();
  const nodes: Array<{
    id: string;
    parentId: string | null;
    role: string;
    text: string;
    ordinal?: number;
  }> = [];
  let userOrdinal = 0;
  for (const line of lines) {
    let evt: {
      type?: string;
      id?: string;
      parentId?: string | null;
      message?: { role?: string; text?: string };
    };
    try {
      evt = JSON.parse(line) as typeof evt;
    } catch {
      continue;
    }
    if (evt.type !== "message" || !evt.id || !evt.message?.role) continue;
    const role = evt.message.role;
    const parentId = evt.parentId ?? null;
    parents.set(evt.id, parentId);
    if (role === "user") userOrdinal += 1;
    const node: {
      id: string;
      parentId: string | null;
      role: string;
      text: string;
      ordinal?: number;
    } = {
      id: evt.id,
      parentId,
      role,
      text: typeof evt.message.text === "string" ? evt.message.text : "",
    };
    if (role === "user") node.ordinal = userOrdinal;
    nodes.push(node);
  }
  const depthOf = (id: string): number => {
    let depth = 0;
    let cur: string | null | undefined = id;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent: string | null = parents.get(cur) ?? null;
      if (parent === null) break;
      depth += 1;
      cur = parent;
    }
    return depth;
  };
  return nodes.map((n) => ({ ...n, depth: depthOf(n.id) }));
}

/** Copy a session file through the line at `cutIndex` into a NEW file with a
 *  fork_of marker. Shared by the ordinal and event-id fork paths. */
function copySessionThrough(
  id: string,
  cutIndex: number,
  dir: string,
  markerFields: Record<string, unknown>,
): string | null {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  if (cutIndex < 0 || cutIndex >= lines.length) return null;
  const newId = newSessionId();
  const kept = lines.slice(0, cutIndex + 1);
  // Rewrite the copied header's id so the new file is self-consistent.
  try {
    const header = JSON.parse(kept[0]!) as { type?: string; id?: string };
    if (header.type === "session") {
      header.id = newId;
      kept[0] = JSON.stringify(header);
    }
  } catch {
    /* keep the original header line */
  }
  const marker = JSON.stringify({ type: "fork_of", parentId: id, ...markerFields });
  writeFileSync(join(dir, `${newId}.jsonl`), `${[...kept, marker].join("\n")}\n`);
  return newId;
}

/** Fork a session at the Nth user message (1-based) — the existing /fork
 *  semantics. */
export function forkSession(
  id: string,
  ordinal: number,
  dir: string = sessionDir(),
): string | null {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  let seen = 0;
  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let evt: SessionFileEvent;
    try {
      evt = JSON.parse(lines[i]!) as SessionFileEvent;
    } catch {
      continue; // corrupt line: not a fork anchor
    }
    if (evt.type === "message" && evt.message?.role === "user") {
      seen += 1;
      if (seen === ordinal) {
        cutIndex = i;
        break;
      }
    }
  }
  if (cutIndex === -1) return null;
  return copySessionThrough(id, cutIndex, dir, { atMessage: ordinal });
}

/** Fork a session through a specific branch node (message event id). The new
 *  session contains every event up to and INCLUDING that node. */
export function forkSessionAtEvent(
  id: string,
  eventId: string,
  dir: string = sessionDir(),
): string | null {
  const path = join(dir, `${id}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let evt: { id?: string };
    try {
      evt = JSON.parse(lines[i]!) as { id?: string };
    } catch {
      continue;
    }
    if (evt.id === eventId) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex === -1) return null;
  return copySessionThrough(id, cutIndex, dir, { atEvent: eventId });
}

/** Append message events to the session file (header written on create;
 *  parentId chains to the file's last message id). The tail scan keeps a
 *  per-process lastId cache — resume reads the file once, steady-state
 *  appends are O(1) instead of re-reading the whole transcript. */
const lastIdBySession = new Map<string, string | null>();

function readLastMessageId(path: string): string | null {
  let prevId: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as { type?: string; id?: string };
      if (evt.type === "message" && evt.id) {
        prevId = evt.id;
        break;
      }
    } catch {
      /* skip */
    }
  }
  return prevId;
}

export function appendSessionMessages(
  id: string,
  cwd: string,
  messages: readonly unknown[],
  dir: string = sessionDir(),
): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const cacheKey = `${dir}:${id}`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd,
      })}\n`,
    );
  }
  // First append this process: scan the tail once. Later appends reuse the
  // cached leaf id (one Runtime appends at most once per turn, sequentially).
  if (!lastIdBySession.has(cacheKey)) {
    lastIdBySession.set(cacheKey, readLastMessageId(path));
  }
  let prevId = lastIdBySession.get(cacheKey) ?? null;
  const lines: string[] = [];
  for (const message of messages) {
    const eventId = crypto.randomUUID();
    lines.push(
      JSON.stringify({
        type: "message",
        id: eventId,
        parentId: prevId,
        timestamp: new Date().toISOString(),
        message,
      }),
    );
    prevId = eventId;
  }
  lastIdBySession.set(cacheKey, prevId);
  appendFileSync(path, `${lines.join("\n")}\n`);
}

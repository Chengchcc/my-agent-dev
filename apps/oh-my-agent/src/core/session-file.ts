import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function sessionDir(): string {
  return process.env.OMA_SESSION_DIR ?? join(homedir(), ".oma", "sessions");
}

export function sessionPath(id: string): string {
  return join(sessionDir(), `${id}.jsonl`);
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Load the transcript messages of a session file (wire-loose shape).
 *  Missing/corrupt files yield [] (the caller falls back to a fresh
 *  session). */
export function loadSessionMessages(id: string): Record<string, unknown>[] {
  const path = sessionPath(id);
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
      };
      if (evt.type === "message" && evt.message?.role) messages.push(evt.message);
    } catch {
      /* skip malformed line */
    }
  }
  return messages;
}

/** Append message events to the session file (header written on create;
 *  parentId chains to the file's last message id). */
export function appendSessionMessages(id: string, cwd: string, messages: readonly unknown[]): void {
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });
  const path = sessionPath(id);
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
  // Chain parentId to the last message id currently in the file.
  let prevId: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as { type?: string; id?: string };
      if (evt.type === "message" && evt.id) prevId = evt.id;
    } catch {
      /* skip */
    }
  }
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
  appendFileSync(path, `${lines.join("\n")}\n`);
}

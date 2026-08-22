import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionTitle,
  deleteSession,
  forkSession,
  listAllSessions,
  listSessions,
  loadSessionMessages,
  renameSession,
  sessionDir,
  sessionDirFor,
} from "./session-file.js";

const dir = `/tmp/oma-session-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(dir, { recursive: true });
process.env.OMA_SESSION_DIR = dir;
beforeEach(
  () => rmSync(dir, { recursive: true, force: true }) || mkdirSync(dir, { recursive: true }),
);

describe("session-file compaction round-trip", () => {
  test("compaction event replaces everything before it with the summary", () => {
    appendSessionMessages("s1", dir, [
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer" },
    ]);
    appendSessionCompaction("s1", "summarized prior context");
    appendSessionMessages("s1", dir, [{ role: "user", text: "after compaction" }]);

    const loaded = loadSessionMessages("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual({
      role: "user",
      text: "<previous_session_summary>\nsummarized prior context\n</previous_session_summary>",
    });
    expect(loaded[1]).toEqual({ role: "user", text: "after compaction" });
  });

  test("without compaction the full transcript replays", () => {
    appendSessionMessages("s2", dir, [
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
    expect(loadSessionMessages("s2")).toHaveLength(2);
  });
});

describe("session-file title", () => {
  test("title event surfaces in listSessions; last one wins; preview falls back", () => {
    appendSessionMessages("t1", dir, [{ role: "user", text: "fix the login bug" }]);
    appendSessionTitle("t1", "Fix login bug");
    appendSessionTitle("t1", "Fix login button on mobile");

    const listed = listSessions().find((s) => s.id === "t1");
    expect(listed?.title).toBe("Fix login button on mobile");
    expect(listed?.preview).toBe("fix the login bug");

    // The title event is not a message: replay is unaffected.
    expect(loadSessionMessages("t1")).toHaveLength(1);
  });

  test("session without title event lists with preview only", () => {
    appendSessionMessages("t2", dir, [{ role: "user", text: "hello" }]);
    const listed = listSessions().find((s) => s.id === "t2");
    expect(listed?.title).toBeUndefined();
    expect(listed?.preview).toBe("hello");
  });
});

describe("session workspace isolation", () => {
  test("OMA_CODING_AGENT_DIR overrides the sessions root", () => {
    const custom = `/tmp/oma-agent-${Math.random().toString(36).slice(2, 8)}`;
    const savedSessionDir = process.env.OMA_SESSION_DIR;
    delete process.env.OMA_SESSION_DIR; // let the agent root win
    process.env.OMA_CODING_AGENT_DIR = custom;
    try {
      appendSessionMessages("s1", dir, [{ role: "user", text: "under custom root" }]);
      const listed = listSessions().find((s) => s.id === "s1");
      expect(listed?.preview).toBe("under custom root");
      // The file landed under the custom agent dir, not the default.
      expect(sessionDir().startsWith(join(custom, "sessions"))).toBe(true);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      if (savedSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSessionDir;
    }
  });

  test("listAllSessions spans workspaces with per-file workspace labels", () => {
    const otherCwd = "/tmp/other-workspace";
    const currentCwd = process.cwd();
    const savedSessionDir = process.env.OMA_SESSION_DIR;
    delete process.env.OMA_SESSION_DIR; // exercise the default per-workspace layout
    try {
      appendSessionMessages(
        "x1",
        otherCwd,
        [{ role: "user", text: "other ws question" }],
        sessionDirFor(otherCwd),
      );
      appendSessionMessages(
        "x2",
        currentCwd,
        [{ role: "user", text: "current ws question" }],
        sessionDirFor(currentCwd),
      );
      const all = listAllSessions();
      const x1 = all.find((s) => s.id === "x1");
      const x2 = all.find((s) => s.id === "x2");
      expect(x1?.workspace).toBe(otherCwd);
      expect(x1?.preview).toBe("other ws question");
      expect(x2?.preview).toBe("current ws question");
      // listSessions (current workspace only) does NOT see the foreign one.
      expect(listSessions().find((s) => s.id === "x1")).toBeUndefined();
    } finally {
      if (savedSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSessionDir;
    }
  });

  test("deleteSession removes the file; renameSession overrides the title", () => {
    appendSessionMessages("s9", dir, [{ role: "user", text: "hello" }]);
    expect(renameSession("s9", "Manual title")).toBe(true);
    expect(listSessions().find((s) => s.id === "s9")?.title).toBe("Manual title");
    expect(deleteSession("s9")).toBe(true);
    expect(existsSync(join(dir, "s9.jsonl"))).toBe(false);
    // Missing session -> false, no throw.
    expect(deleteSession("missing")).toBe(false);
    expect(renameSession("missing", "x")).toBe(false);
  });
});

describe("forkSession", () => {
  test("fork copies events up to the Nth user message and marks the parent", () => {
    appendSessionMessages("parent", dir, [
      { role: "user", text: "question one" },
      { role: "assistant", text: "answer one" },
    ]);
    appendSessionMessages("parent", dir, [
      { role: "user", text: "question two" },
      { role: "assistant", text: "answer two" },
    ]);

    const forkId = forkSession("parent", 1);
    expect(forkId).not.toBeNull();
    // The fork's transcript ends at (incl.) the first user message.
    const forkMessages = loadSessionMessages(forkId!);
    expect(forkMessages).toEqual([{ role: "user", text: "question one" }]);
    // The parent file is untouched.
    expect(loadSessionMessages("parent")).toHaveLength(4);
    // The fork's file header carries its own id.
    const header = loadSessionEvents(forkId!)[0] as { type?: string; id?: string };
    expect(header.type).toBe("session");
    expect(header.id).toBe(forkId);
    // Listing shows the branch relationship (pi's fork dot).
    const forkSummary = listSessions().find((s) => s.id === forkId);
    expect(forkSummary?.forkOf).toBe("parent");
    // The parent itself is unmarked.
    const parentSummary = listSessions().find((s) => s.id === "parent");
    expect(parentSummary?.forkOf).toBeUndefined();
  });

  test("out-of-range ordinal and missing file return null", () => {
    appendSessionMessages("p2", dir, [{ role: "user", text: "only" }]);
    expect(forkSession("p2", 2)).toBeNull();
    expect(forkSession("missing", 1)).toBeNull();
  });
});

/** Read every parsed JSON event of a session file (test helper). */
function loadSessionEvents(id: string): Record<string, unknown>[] {
  const lines = readFileSync(join(dir, `${id}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

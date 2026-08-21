import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionTitle,
  listAllSessions,
  listSessions,
  loadSessionMessages,
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
});

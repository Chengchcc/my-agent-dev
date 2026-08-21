import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionTitle,
  listSessions,
  loadSessionMessages,
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

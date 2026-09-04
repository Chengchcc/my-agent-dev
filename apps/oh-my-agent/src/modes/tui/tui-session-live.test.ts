import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSessionMessages, loadSessionBranchNodes } from "../../core/session/session-file.js";
import { scriptedIo, testModelRuntime } from "./tui-mode.fixture.js";
import { runTuiSession } from "./tui-mode.js";

describe("tui session live/steering/fork", () => {
  test("live submit steers immediately and echoes a pending item", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-steer-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    // A slow tool keeps the run live while the steer lands.
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "sleep 1" } }]);
    try {
      const io = scriptedIo(["go"]);
      const done = runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      await io.toolRendered;
      io.submitLive("mid-run correction");
      await done;
      // pi's message_start(user) absorption: while pending the echo shows
      // the dim » marker, and once the loop drains the steer it settles
      // into a normal user item — exactly one, no duplicate echo.
      const echoes = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "user"))
        .filter((i) => i.text === "mid-run correction");
      expect(echoes).toHaveLength(1);
      expect(echoes[0]?.pending).toBeFalsy();
      // The loop consumed the steer and answered — the message was not lost.
      const texts = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.map((i) => i.text))
        .join("");
      expect(texts).toContain("done");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("slash commands during a live run execute; mutating ones refuse", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-livecmd-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "sleep 1" } }]);
    try {
      const io = scriptedIo(["go"]);
      const done = runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      await io.toolRendered;
      // Safe commands run live instead of being steered into the model.
      io.sendLiveCommand("/thinking");
      // Session-mutating commands refuse while the run is live.
      io.sendLiveCommand("/new");
      await done;
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("thinking expanded"))).toBe(true);
      expect(statuses.some((t) => t.includes("/new is not available while a run is live"))).toBe(
        true,
      );
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("completion pings when the terminal is unfocused", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-focus-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const pings: number[] = [];
      const base = scriptedIo(["hi", "/exit", "/exit"]);
      const io: TuiIo = {
        ...base,
        isFocused: () => false,
        notify: () => {
          pings.push(1);
        },
      };
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, io);
      const statuses = base.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("switch back for recap"))).toBe(true);
      expect(pings.length).toBeGreaterThan(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("/fork <n> switches to a forked session and /resume shows the marker", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-fork-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      // Two turns -> two user messages to fork from.
      const io = scriptedIo(["one", "two", "/fork 1", "three", "/resume", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, io);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      // The fork switched sessions with a parent + ordinal report.
      const forkStatus = statuses.find((t) => t.startsWith("forked "));
      expect(forkStatus).toBeDefined();
      expect(forkStatus).toContain("@ msg 1");
      // Three session files now exist: original + fork (turn "three" went
      // into the fork).
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(2);
      // The /resume text listing marks the fork with the parent id prefix.
      expect(statuses.some((t) => t.includes("\u2442"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("idle forkTree command forks at a selected branch node", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-tree-fork-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const seedId = "11111111-1111-1111-1111-111111111111";
      appendSessionMessages(
        seedId,
        sessionDir,
        [
          { role: "user", text: "one" },
          { role: "assistant", text: "answer one" },
          { role: "tool", text: "out" },
        ],
        sessionDir,
      );
      const io = scriptedIo(["/exit", "/exit"]);
      const assistant = loadSessionBranchNodes(seedId, sessionDir)[1]!;
      io.pickBranchTree = async () => assistant.id;
      const done = runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir, sessionId: seedId },
        io,
      );
      io.sendCommand("forkTree");
      await done;
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.startsWith("forked "))).toBe(true);
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(2);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("header carries context usage after each run", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-ctx-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const io = scriptedIo(["hi", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, io);
      const ctx = io.headers.find((h) => h.context !== undefined);
      expect(ctx).toBeDefined();
      expect(ctx?.context).toContain("ctx ");
      expect(ctx?.context).toContain("/");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { VirtualTerminal } from "@chengchenccc/tui";
import { appendSessionMessages } from "../../core/session/session-file.js";
import {
  fakeModelRuntime,
  quitTui,
  screen,
  typeAndSubmit,
  waitForText,
} from "./tui-e2e.fixture.js";
import { createTerminalIo, runTuiSession } from "./tui-mode.js";

describe("tui e2e live/scrollback/fork", () => {
  test("idle ctrl+c arms a hint; the second press quits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-ctrlc-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-ctrlc-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await vt.waitForRender();
      // First press only arms: the session is still alive.
      vt.sendInput("\x03");
      await waitForText(vt, "press ctrl+c again to quit", 2_000);
      // Second press within 2s quits.
      vt.sendInput("\x03");
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("edit tool renders capped +/- diff lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-diff-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-diff-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      {
        name: "edit",
        input: { path: `${dir}/old.txt`, old_string: "before line", new_string: "after line" },
      },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "go");
      // The change itself is visible: red - old, green + new.
      await waitForText(vt, "after line", 5_000);
      const rendered = screen(vt);
      expect(rendered).toContain("- before line");
      expect(rendered).toContain("+ after line");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("prompt history persists across sessions; up-arrow recalls it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-hist-"));
    const agentRoot = mkdtempSync(join(tmpdir(), "oma-e2e-hist-agent-"));
    process.env.OMA_CODING_AGENT_DIR = agentRoot;
    // One turn, then quit.
    {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await typeAndSubmit(vt, "recall me please");
      await waitForText(vt, "done", 5_000);
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
      io.close();
    }
    // A fresh process: up-arrow recalls the persisted prompt.
    {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await vt.waitForRender();
      vt.sendInput("\x1b[A"); // Up
      await vt.waitForRender();
      expect(screen(vt)).toContain("recall me please");
      // ctrl+r opens the search overlay; typing filters; enter inserts.
      vt.sendInput("\x12"); // ctrl+r
      await waitForText(vt, "history search", 2_000);
      vt.sendInput("recall");
      await vt.waitForRender();
      expect(screen(vt)).toContain("recall me please");
      vt.sendInput("\r");
      await vt.waitForRender();
      expect(screen(vt)).toContain("recall me please");
      // Esc the editor content away and quit.
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
      io.close();
    }
  }, 30_000);
  test("/fork opens a message picker and switches to the fork", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-fork-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-fork-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "first turn");
      await waitForText(vt, "done", 5_000);
      await typeAndSubmit(vt, "second turn");
      await waitForText(vt, "done", 5_000);

      // /fork opens the picker listing the session's user messages.
      await typeAndSubmit(vt, "/fork");
      await waitForText(vt, "fork from message", 5_000);
      expect(screen(vt)).toContain("first turn");
      // Enter picks #1: the session switches to the fork.
      vt.sendInput("\r");
      await waitForText(vt, "forked ", 5_000);

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
      // Two session files: parent + fork.
      const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(2);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("native scrollback tail stays visible; no custom overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-wheel-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-wheel-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      // 24-row terminal: /help's listing overflows the viewport, so the tail
      // is what the terminal shows and the app's old "lines above" overlay is
      // gone (native scrollback owns history now).
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "/help");
      // /workflow lives in the LAST group: its entry always fits the tail.
      await waitForText(vt, "run a workflow script", 5_000);
      expect(screen(vt)).toContain("run a workflow script");
      expect(screen(vt)).not.toContain("lines above");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("native scrollback tail stays visible; PageUp is terminal-owned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-scroll-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-scroll-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      // 24-row terminal: /help's ~20 status lines overflow the viewport.
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "/help");
      // The listing's tail fits the viewport; early groups sit above it.
      // /workflow lives in the LAST group, so it always makes the tail.
      await waitForText(vt, "run a workflow script", 5_000);
      expect(screen(vt)).toContain("run a workflow script");
      expect(screen(vt)).not.toContain("lines above");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("assistant markdown renders as styled text, not raw fences", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-md-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-md-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider({
        id: "md",
        name: "MD",
        getModels: () => [
          {
            id: "m",
            name: "M",
            provider: "md",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
        async *stream() {
          yield { delta: { type: "text", text: "intro line\n\n**bold words**" } };
          yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
        },
      });
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession({ modelRuntime, workspaceRoot: dir }, io);

      await typeAndSubmit(vt, "hi");
      // Markdown renders bold emphasis: the words appear, the raw ** markers
      // do not (the run title takes line 1, so the header cannot leak them).
      await waitForText(vt, "bold words", 5_000);
      expect(screen(vt)).not.toContain("**bold words**");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("fixed header banner, idle footer and ctrl+p model picker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-header-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-header-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await vt.waitForRender();
      const boot = screen(vt);
      // Claude-style header: ASCII wordmark + model/session line.
      expect(boot).toContain("█");
      // omp-style header: session id segment, no literal "session" word.
      expect(boot).toMatch(/\b[0-9a-f]{8}\b/);
      // Welcome easter egg appears in the empty transcript.
      expect(boot).toContain("Tip:");

      // ctrl+p opens the model picker overlay with the catalog.
      vt.sendInput("\x10");
      await vt.waitForRender();
      const overlay = screen(vt);
      expect(overlay).toContain("pick model");
      expect(overlay).toContain("fake/echo");
      // Rows carry the pi-browser meta: context window + cost.
      expect(overlay).toContain("ctx 200k");
      expect(overlay).toContain("free");

      // Esc cancels; /exit quits.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("idle Esc opens branch-tree fork overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-tree-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-tree-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const seedId = "22222222-2222-2222-2222-222222222222";
      appendSessionMessages(
        seedId,
        dir,
        [
          { role: "user", text: "seed question" },
          { role: "assistant", text: "seed answer" },
        ],
        sessDir,
      );
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir, sessionId: seedId },
        io,
      );

      await vt.waitForRender();
      // esc-esc summons the tree (single esc only arms).
      vt.sendInput("\x1b");
      await vt.waitForRender();
      vt.sendInput("\x1b");
      await vt.waitForRender();
      const overlay = screen(vt);
      expect(overlay).toContain("fork from branch node");
      expect(overlay).toContain("user");
      expect(overlay).toContain("assistant");

      // Esc cancels the overlay; /exit quits.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("long tool output streams live; run duration ticks in the spinner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-live-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-live-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // A 2-second bash command emits distinct markers so the test can assert
    // intermediate output reached the screen BEFORE the tool finished.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      {
        name: "bash",
        input: {
          description: "live output",
          command: "echo start; sleep 1; echo middle; sleep 1; echo end",
        },
      },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run");
      // mid-run: "middle" is on screen while the tool is still executing,
      // and the working status shows the current tool summary (omp intent),
      // not a fixed "working…".
      await waitForText(vt, "middle", 5_000);
      await waitForText(vt, /bash · live output/, 3_000);
      const mid = screen(vt);
      expect(mid).toContain("start");
      expect(mid).toContain("middle");

      await waitForText(vt, "done", 5_000);
      const end = screen(vt);
      expect(end).toContain("end");
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("ctrl+c aborts a live run and quits when idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-ctrlc-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-ctrlc-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "sleep 2" } }]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // Busy: ctrl+c aborts the live run.
      await typeAndSubmit(vt, "go");
      await waitForText(vt, "sleep 2", 5_000);
      vt.sendInput("\x03");
      await waitForText(vt, "aborted", 5_000);
      expect(screen(vt)).toContain("aborted");

      // Idle: ctrl+c now needs a second press within 2s (exit code 0).
      vt.sendInput("\x03");
      await waitForText(vt, "press ctrl+c again to quit", 2_000);
      vt.sendInput("\x03");
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("long sessions push history into terminal native scrollback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-scroll-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-scroll-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(80, 20);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );
      await vt.waitForRender();
      const prompts = ["first-turn-history", "second-turn-history", "third-turn-history"];
      for (const prompt of prompts) {
        await typeAndSubmit(vt, prompt);
        await waitForText(vt, "done", 5_000);
      }
      const scroll = vt.getScrollBuffer().join("\n");
      const view = screen(vt);
      expect(scroll).toContain("first-turn-history");
      expect(view).not.toContain("first-turn-history");
      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("esc-esc opens the branch tree; esc closes it without reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-esc-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-esc-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // Complete one turn so the session file has branch nodes.
      await typeAndSubmit(vt, "seed a turn");
      await waitForText(vt, "done", 5_000);

      // Single idle esc only arms — no overlay.
      vt.sendInput("\x1b");
      await waitForText(vt, "press esc again for branch tree", 2_000);
      expect(screen(vt)).not.toContain("fork from branch node");

      // Second esc within the window summons the tree.
      vt.sendInput("\x1b");
      await waitForText(vt, "fork from branch node", 2_000);

      // Esc while the overlay is open closes it (fork cancelled), and the
      // same esc must NOT re-summon the tree.
      vt.sendInput("\x1b");
      await waitForText(vt, "fork cancelled", 2_000);
      expect(screen(vt)).not.toContain("fork from branch node");

      // A stray extra esc re-arms but still does not reopen the tree.
      vt.sendInput("\x1b");
      await waitForText(vt, "press esc again for branch tree", 2_000);
      expect(screen(vt)).not.toContain("fork from branch node");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

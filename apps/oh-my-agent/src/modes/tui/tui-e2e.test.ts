import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualTerminal } from "@chengchenccc/tui";
import {
  fakeModelRuntime,
  quitTui,
  screen,
  typeAndSubmit,
  waitForText,
} from "./tui-e2e.fixture.js";
import { createTerminalIo, runTuiSession } from "./tui-mode.js";

describe("tui e2e: model I/O on a virtual terminal", () => {
  test("initialPrompt prefills the editor and submits on Enter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-init-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-init-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir, initialPrompt: "123" },
        io,
      );

      await vt.waitForRender();
      // The editor shows the prefilled prompt (`oma "123"` boot).
      expect(screen(vt)).toContain("123");
      // Enter sends it as a normal first turn.
      vt.sendInput("\r");
      await waitForText(vt, "done", 5_000);
      expect(screen(vt)).toContain("123");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("user input echoes, assistant answer renders, session persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      // Drive the session in the background; input comes from the vt.
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // 1. Typed characters appear in the editor (input echo).
      vt.sendInput("what is 2+2");
      await vt.waitForRender();
      expect(screen(vt)).toContain("what is 2+2");

      // 2. Submit (Enter) -> run starts -> assistant text renders.
      await typeAndSubmit(vt, "");
      // The fake provider answers "done"; wait for it to render.
      await vt.waitForRender();
      const rendered = screen(vt);
      // 3. The user's input is echoed in the transcript (cyan "> " prefix).
      expect(rendered).toContain("what is 2+2");
      // 4. The assistant's final answer is rendered (markdown-free text).
      expect(rendered).toContain("done");

      // 5. /exit ends the session cleanly.
      await quitTui(vt);
      expect(await sessionDone).toBe(0);

      // 6. The turn persisted to the session file: user + assistant.
      const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const events = readFileSync(join(sessDir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; message?: { role: string } });
      const messages = events.filter((e) => e.type === "message");
      expect(messages[0]?.message?.role).toBe("user");
      expect(messages.some((m) => m.message?.role === "assistant")).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("tool call renders its args and result on screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-tool-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-tool-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // Script the fake provider to emit one bash tool_use, then fall back to
    // text: the loop executes the real bash tool and streams its events.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "probe", command: "echo hi" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 40);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run a tool");
      await vt.waitForRender();
      const rendered = screen(vt);

      // Pi-style presentation: success marker + bold name + `$ cmd` summary.
      expect(rendered).toContain("bash");
      expect(rendered).toContain("$ echo hi");
      // The settled result shows the bash output, not the exit-code notice.
      expect(rendered).toContain("hi");
      expect(rendered).not.toContain("[exit: 0]");
      expect(rendered).toContain("✔");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("failing tool renders the error marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-toolerr-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-toolerr-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { command: "sh -c 'exit 3'" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "fail a tool");
      await vt.waitForRender();
      const rendered = screen(vt);
      // Error marker (pi's toolErrorBg equivalent) + the failing command.
      expect(rendered).toContain("✘");
      expect(rendered).toContain("$ sh -c 'exit 3'");
      expect(rendered).toContain("[exit: 3]");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("second turn sees the first turn's transcript (session continuity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e2-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e2-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 40);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "first question");
      await vt.waitForRender();
      expect(screen(vt)).toContain("done");
      await typeAndSubmit(vt, "second question");
      await vt.waitForRender();
      await quitTui(vt);
      expect(await sessionDone).toBe(0);

      // Both turns are on screen (scrollback viewport is 40 rows).
      const final = screen(vt);
      expect(final).toContain("first question");
      expect(final).toContain("second question");

      // One session file, two user messages, at least two assistant messages.
      const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
      const messages = readFileSync(join(sessDir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; message?: { role: string } })
        .filter((e) => e.type === "message");
      expect(messages.filter((m) => m.message?.role === "user")).toHaveLength(2);
      expect(messages.filter((m) => m.message?.role === "assistant").length).toBeGreaterThanOrEqual(
        2,
      );
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("spinner shows while running and esc aborts the live run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-abort-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-abort-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // A slow bash tool keeps the run live long enough to observe the
    // spinner and interrupt it mid-flight.
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "slow", command: "sleep 2" } },
    ]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "do something slow");
      await waitForText(vt, /bash · slow/, 3_000);
      const mid = screen(vt);
      expect(mid).toContain("esc to abort");
      // Esc (raw \x1b) aborts the live Run instead of the editor.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      expect(screen(vt)).toContain("aborted");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("ctrl+t expands the collapsed thinking block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-think-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-think-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_THINKING = "first reasoning line\nsecond reasoning line";
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "think about it");
      await vt.waitForRender();
      // Collapsed: only the first reasoning line is visible, with a hint.
      const collapsed = screen(vt);
      expect(collapsed).toContain("first reasoning line");
      expect(collapsed).toContain("ctrl+t");
      expect(collapsed).not.toContain("second reasoning line");

      // ctrl+t (raw \x14) toggles the full thinking block on.
      vt.sendInput("\x14");
      await vt.waitForRender();
      expect(screen(vt)).toContain("second reasoning line");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_THINKING;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("ctrl+o expands full tool result detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-detail-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-detail-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { description: "probe", command: "seq 1 60" } },
    ]);
    try {
      // Tall viewport: expanded pretty JSON plus the token status line must
      // fit without scrolling the top of the output off screen.
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run a tool");
      // Collapsed: header + args + one-line summary with the truncation hint
      // (seq 1 60 output far exceeds the one-line cap).
      await waitForText(vt, "seq 1 60", 5000);
      await waitForText(vt, "ctrl+o", 5000);

      // ctrl+o (raw \x0f) toggles full pretty-JSON detail on.
      vt.sendInput("\x0f");
      await waitForText(vt, "command", 5000);
      await waitForText(vt, "description", 5000);

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("typing / offers the slash-command menu; /help lists commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-slash-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-slash-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      const vt = new VirtualTerminal(100, 45);
      const io = createTerminalIo(vt, dir);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // Typing "/" pops the command menu; "he" filters it to /help.
      vt.sendInput("/");
      await vt.waitForRender();
      const menu = screen(vt);
      expect(menu).toContain("help");
      expect(menu).toContain("exit");

      vt.sendInput("help");
      await vt.waitForRender();
      vt.sendInput("\r");
      await vt.waitForRender();
      // /help echoes the command table into the transcript (grouped).
      const rendered = screen(vt);
      // The listing is longer than the viewport now: assert on the tail
      // groups (workflow is last) that always fit the sliced window.
      expect(rendered).toContain("[workflow]");
      expect(rendered).toContain("/workflow <path|script>");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("/resume opens an interactive overlay: esc cancels, enter resumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-resume-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-resume-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    const seed = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, `${seed}.jsonl`),
      [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", text: "hello resume" },
        }),
      ].join("\n"),
    );
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt, dir);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      // /resume opens the picker overlay with the seeded session visible.
      await typeAndSubmit(vt, "/resume");
      await vt.waitForRender();
      const overlay = screen(vt);
      expect(overlay).toContain("resume session");
      expect(overlay).toContain("hello resume");

      // Esc cancels: overlay closes, transcript notes the cancel.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      expect(screen(vt)).toContain("resume cancelled");
      expect(screen(vt)).not.toContain("↑/↓ select");

      // Reopen and select with Enter: the session resumes.
      await typeAndSubmit(vt, "/resume");
      await vt.waitForRender();
      vt.sendInput("\r");
      await vt.waitForRender();
      expect(screen(vt)).toContain(`resumed session: ${seed} (1 messages)`);
      // Resumed history is rendered in the transcript, not just a status.
      expect(screen(vt)).toContain("hello resume");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
  test("busy Enter steers immediately with a dim » echo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-steer-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-steer-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    // A slow tool keeps the run live while the steer lands.
    process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "bash", input: { command: "sleep 1" } }]);
    try {
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "go");
      await waitForText(vt, "sleep 1", 5_000); // tool running -> live

      // Busy: type + Enter STEERS immediately (pi streamingBehavior:"steer") —
      // no queue, no empty-Enter flush gesture. The echo is a dim » item.
      vt.sendInput("continue the work");
      await vt.waitForRender();
      vt.sendInput("\r");
      await waitForText(vt, "\u00bb continue the work", 5_000);
      // The old queue panel is gone.
      expect(screen(vt)).not.toContain("follow-up");

      // The loop consumed the steer and completed the run.
      await waitForText(vt, "done", 5_000);

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_FAKE_TOOL;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

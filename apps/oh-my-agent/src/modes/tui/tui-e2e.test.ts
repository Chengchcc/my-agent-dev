import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { VirtualTerminal } from "@chengchenccc/tui";
import { registerBuiltinProviders } from "../../core/run-runtime.js";
import { createTerminalIo, runTuiSession } from "./tui-mode.js";

/** E2E: the model's input/output behavior as shown ON SCREEN, through a
 *  real xterm terminal emulation (VirtualTerminal). Covers the full path:
 *  keystrokes -> editor -> run loop -> fake provider -> streaming render ->
 *  session file. No pipes, no sleeps-for-real-terminal. */

function fakeModelRuntime() {
  const modelRuntime = createModelRuntime();
  process.env.OMA_FAKE_PROVIDER = "1";
  registerBuiltinProviders(modelRuntime, process.env);
  return modelRuntime;
}

/** Join the viewport into one string for substring assertions. */
function screen(vt: VirtualTerminal): string {
  return vt.getViewport().join("\n");
}

async function typeAndSubmit(vt: VirtualTerminal, text: string): Promise<void> {
  if (text) vt.sendInput(text);
  await vt.waitForRender();
  vt.sendInput("\r");
  await vt.waitForRender();
}

describe("tui e2e: model I/O on a virtual terminal", () => {
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
      expect(rendered).toContain("> what is 2+2");
      // 4. The assistant's final answer is rendered (markdown-free text).
      expect(rendered).toContain("done");

      // 5. /exit ends the session cleanly.
      await typeAndSubmit(vt, "/exit");
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
      // The settled result is drawn under the tool line (bash content + exit).
      expect(rendered).toContain("[exit: 0]");
      expect(rendered).toContain("✔");

      await typeAndSubmit(vt, "/exit");
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

      await typeAndSubmit(vt, "/exit");
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
      await typeAndSubmit(vt, "/exit");
      expect(await sessionDone).toBe(0);

      // Both turns are on screen (scrollback viewport is 40 rows).
      const final = screen(vt);
      expect(final).toContain("> first question");
      expect(final).toContain("> second question");

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
      await vt.waitForRender();
      // While the run is live: animated status line is on screen.
      expect(screen(vt)).toContain("working");
      expect(screen(vt)).toContain("esc to abort");
      // Esc (raw \x1b) aborts the live Run instead of the editor.
      vt.sendInput("\x1b");
      await vt.waitForRender();
      expect(screen(vt)).toContain("aborted");

      await typeAndSubmit(vt, "/exit");
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

      await typeAndSubmit(vt, "/exit");
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
      const vt = new VirtualTerminal(100, 30);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "run a tool");
      await vt.waitForRender();
      // Collapsed: header + args + one-line summary with the truncation hint
      // (seq 1 60 output far exceeds the one-line cap).
      const collapsed = screen(vt);
      expect(collapsed).toContain("seq 1 60");
      expect(collapsed).toContain("ctrl+o");

      // ctrl+o (raw \x0f) toggles full pretty-JSON detail on.
      vt.sendInput("\x0f");
      await vt.waitForRender();
      const expanded = screen(vt);
      expect(expanded).toContain("command");
      expect(expanded).toContain("description");

      await typeAndSubmit(vt, "/exit");
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
      // /help echoes the command table into the transcript.
      const rendered = screen(vt);
      expect(rendered).toContain("/abort");
      expect(rendered).toContain("quit the session");

      await typeAndSubmit(vt, "/exit");
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

      await typeAndSubmit(vt, "/exit");
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);
});

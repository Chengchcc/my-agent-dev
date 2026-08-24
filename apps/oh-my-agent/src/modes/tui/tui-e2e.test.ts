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

/** /exit now requires a second confirmation; this sends both. */
async function quitTui(vt: VirtualTerminal): Promise<void> {
  await typeAndSubmit(vt, "/exit");
  await typeAndSubmit(vt, "/exit");
}

/** Poll the viewport until a substring/regex appears (event-driven
 *  alternative to fixed sleeps for async run transitions). */
async function waitForText(
  vt: VirtualTerminal,
  needle: string | RegExp,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const haystack = screen(vt);
    const hit = needle instanceof RegExp ? needle.test(haystack) : haystack.includes(needle);
    if (hit) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for text: ${String(needle)}`);
}

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
      await vt.waitForRender();
      // While the run is live: animated status line is on screen.
      expect(screen(vt)).toContain("working");
      expect(screen(vt)).toContain("esc to abort");
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

  test("mouse wheel scrolls the transcript like PageUp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-e2e-wheel-"));
    const sessDir = mkdtempSync(join(tmpdir(), "oma-e2e-wheel-sess-"));
    process.env.OMA_SESSION_DIR = sessDir;
    try {
      // 24-row terminal: /help's listing overflows the viewport.
      const vt = new VirtualTerminal(100, 24);
      const io = createTerminalIo(vt);
      const sessionDone = runTuiSession(
        { modelRuntime: fakeModelRuntime(), workspaceRoot: dir },
        io,
      );

      await typeAndSubmit(vt, "/help");
      // /workflow lives in the LAST group: its entry always fits the tail.
      await waitForText(vt, "run a workflow script", 5_000);
      // SGR wheel-up (button 64): three per notch-equivalent steps reveal the
      // scroll indicator; wheel-down (65) walks it back.
      for (let i = 0; i < 6; i++) vt.sendInput("\x1b[<64;10;10M");
      await waitForText(vt, "lines above", 2_000);
      for (let i = 0; i < 6; i++) vt.sendInput("\x1b[<65;10;10M");
      await vt.waitForRender();
      await vt.waitForRender();
      expect(screen(vt)).not.toContain("lines above");

      await quitTui(vt);
      expect(await sessionDone).toBe(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(dir, { recursive: true, force: true });
      rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("PageUp shows a scroll indicator inside the viewport; End returns", async () => {
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
      vt.sendInput("\x1b[5~"); // PageUp
      await waitForText(vt, "lines above", 2_000);
      // End returns to the latest; the indicator disappears.
      vt.sendInput("\x1b[F");
      await vt.waitForRender();
      await vt.waitForRender();
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
      expect(boot).toMatch(/session \S+/);
      expect(boot).toContain("^p model");

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
      // and the spinner carries an elapsed-seconds counter (tick at 1s).
      await waitForText(vt, "middle", 5_000);
      await waitForText(vt, /working… \(\d+s/, 3_000);
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
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { registerBuiltinProviders } from "../../core/run-runtime.js";
import { runTuiSession, type TuiIo } from "./tui-mode.js";
import { applyEvent, applyOutcome, initialViewState, type TuiViewState } from "./view-state.js";

/** Scripted TuiIo: feeds idle inputs sequentially, captures renders.
 *  Live submits (during a run) are recorded and forwarded to the handler. */
function scriptedIo(inputs: string[]): TuiIo & { renders: TuiViewState[]; live: string[] } {
  const renders: TuiViewState[] = [];
  const live: string[] = [];
  let i = 0;
  let liveHandler: ((text: string) => void) | null = null;
  return {
    renders,
    live,
    render: (state) => renders.push(state),
    waitForInput: () => Promise.resolve(i < inputs.length ? inputs[i++]! : null),
    onLiveInput: (handler) => {
      liveHandler = handler;
    },
    // ponytail: tests push live submits through this hook rather than
    // simulating keystroke timing.
    submitLive: (text: string) => {
      live.push(text);
      liveHandler?.(text);
    },
    close: () => {},
  };
}

function testModelRuntime() {
  const modelRuntime = createModelRuntime();
  process.env.OMA_FAKE_PROVIDER = "1";
  registerBuiltinProviders(modelRuntime, process.env);
  return modelRuntime;
}

describe("view-state folding", () => {
  test("message stream accumulates into one assistant item", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "hello " });
    applyEvent(state, { type: "message_update", text: "world" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "agent_end", status: "completed" });
    expect(state.runs).toHaveLength(1);
    const items = state.runs[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "hello world" });
    expect(state.runs[0]!.running).toBe(false);
  });

  test("tool start/end keeps one item carrying args and result", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls -la" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const items = state.runs[0]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(tool?.streaming).toBe(false);
    // Args (from start) and result (from end) survive on the settled item so
    // the renderer can draw them under the tool name.
    expect(tool).toMatchObject({
      text: "bash",
      input: { command: "ls -la" },
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
  });

  test("failed outcome appends an error run", () => {
    const state = initialViewState();
    applyOutcome(state, { status: "failed", error: "boom" });
    expect(state.runs.at(-1)?.items[0]?.kind).toBe("error");
  });
});

describe("tui session (headless, fake provider)", () => {
  test("assistant text renders incrementally while the run streams", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-stream-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      // Chunked provider: yields two text deltas so message_update fires
      // twice; the fake provider yields a single chunk and would not prove
      // incremental rendering.
      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider({
        id: "chunky",
        name: "Chunky",
        getModels: () => [
          {
            id: "stream",
            name: "Stream",
            provider: "chunky",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
        async *stream() {
          yield { delta: { type: "text", text: "hel" } };
          yield { delta: { type: "text", text: "lo" } };
          yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
        },
      });

      // Snapshot each render so intermediate states are observable (the
      // scriptedIo above records the same mutable state object by reference).
      const snapshots: TuiViewState[] = [];
      let i = 0;
      const inputs = ["hi", "/exit"];
      const io: TuiIo = {
        render: (state) => snapshots.push(JSON.parse(JSON.stringify(state)) as TuiViewState),
        waitForInput: () => Promise.resolve(i < inputs.length ? inputs[i++]! : null),
        setBusy: () => {},
        onLiveInput: () => {},
        close: () => {},
      };
      const code = await runTuiSession({ modelRuntime, workspaceRoot: sessionDir }, io);
      expect(code).toBe(0);

      // The run rendered while live (not only after it settled).
      const liveRenders = snapshots.filter((s) => s.runs.some((r) => r.running));
      expect(liveRenders.length).toBeGreaterThan(0);

      // An intermediate render carries the partial text, proving chunks hit
      // the screen before the run finished.
      const partial = liveRenders.some((s) =>
        s.runs.some((r) => r.items.some((it) => it.kind === "assistant" && it.text === "hel")),
      );
      expect(partial).toBe(true);

      // The final render carries the full accumulated text.
      const last = snapshots.at(-1)!;
      const texts = last.runs.flatMap((r) => r.items.map((it) => it.text)).join("");
      expect(texts).toContain("hello");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("multi-turn session persists both turns to one session file", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const io = scriptedIo(["first question", "second question"]);
      const code = await runTuiSession(
        {
          modelRuntime: testModelRuntime(),
          workspaceRoot: sessionDir,
        },
        io,
      );
      expect(code).toBe(0);
      // both turns rendered as user echo
      const users = io.renders.at(-1)!.runs.filter((r) => r.items.some((i) => i.kind === "user"));
      expect(users).toHaveLength(2);
      // exactly one session file, containing both turns' messages
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const lines = readFileSync(join(sessionDir, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; message?: { role: string; text?: string } });
      const messages = lines.filter((l) => l.type === "message");
      expect(messages.filter((m) => m.message?.role === "user")).toHaveLength(2);
      expect(messages.some((m) => m.message?.role === "assistant")).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("/model and /session are handled without starting a run", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const io = scriptedIo(["/session", "/model fake/echo", "/exit"]);
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      expect(code).toBe(0);
      const last = io.renders.at(-1)!;
      const statuses = last.runs.flatMap((r) => r.items.filter((i) => i.kind === "status"));
      expect(statuses.length).toBeGreaterThan(0);
      // no runs started beyond the command echoes
      expect(last.runs.every((r) => r.running === false)).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);
});

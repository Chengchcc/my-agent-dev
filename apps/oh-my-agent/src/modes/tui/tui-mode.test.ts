import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { registerBuiltinProviders } from "../../core/run-runtime.js";
import { sessionDirFor } from "../../core/session-file.js";
import { runTuiSession, type TuiIo } from "./tui-mode.js";
import { applyEvent, initialViewState, type TuiViewState } from "./view-state.js";

/** Scripted TuiIo: feeds idle inputs sequentially, captures renders.
 *  Live submits (during a run) are recorded and forwarded to the handler. */
function scriptedIo(
  inputs: string[],
): TuiIo & { renders: TuiViewState[]; live: string[]; toolRendered: Promise<void> } {
  const renders: TuiViewState[] = [];
  const live: string[] = [];
  let i = 0;
  let liveHandler: ((text: string) => void) | null = null;
  const { promise: toolRendered, resolve: markToolRendered } = Promise.withResolvers<void>();
  return {
    renders,
    live,
    toolRendered,
    render: (state) => {
      renders.push(state);
      // Resolve once a live tool item hit the screen: at that point the
      // real-time persist hook has already written the turn to the file.
      if (
        state.runs.some((run) => run.items.some((item) => item.kind === "tool" && item.streaming))
      ) {
        markToolRendered();
      }
    },
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

  test("message_end settles thinking so the next turn starts a fresh block", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "thinking_update", text: "turn one reasoning" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "answer" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "thinking_update", text: "turn two reasoning" });
    const thinking = state.runs[0]!.items.filter((i) => i.kind === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]).toMatchObject({ text: "turn one reasoning", streaming: false });
    expect(thinking[1]).toMatchObject({ text: "turn two reasoning", streaming: true });
  });

  test("initial view state hides thinking detail and tool detail", () => {
    const state = initialViewState();
    expect(state.showThinking).toBe(false);
    expect(state.showToolDetail).toBe(false);
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

  test("slash commands: help lists, unknown hints, /model lists catalog", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-cmd-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    const registered: number[] = [];
    try {
      const base = scriptedIo(["/help", "/nonsense", "/model", "/model fake/missing", "/exit"]);
      const io: TuiIo = {
        ...base,
        setSlashCommands: (commands) => registered.push(commands.length),
      };
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      expect(code).toBe(0);
      // The command table reached the autocomplete seam once.
      expect(registered).toEqual([11]);
      const statuses = base.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      // /help lists the commands
      expect(statuses.some((t) => t.includes("/help"))).toBe(true);
      expect(statuses.some((t) => t.includes("/abort"))).toBe(true);
      // unknown command hints at /help
      expect(statuses.some((t) => t.includes("unknown command /nonsense"))).toBe(true);
      // /model without args lists the catalog, fake/echo present
      expect(statuses.some((t) => t.includes("fake/echo"))).toBe(true);
      // /model with an id not in the catalog is rejected
      expect(statuses.some((t) => t.includes("unknown model: fake/missing"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("/resume lists saved sessions and resumes by unique prefix", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-resume-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      // Seed one saved session with a recognizable first user message.
      const seed = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, `${seed}.jsonl`),
        [
          JSON.stringify({
            type: "message",
            id: "m1",
            message: { role: "user", text: "hello resume" },
          }),
          JSON.stringify({
            type: "title",
            timestamp: "2026-08-21T00:00:00Z",
            title: "Greet resume",
          }),
          JSON.stringify({
            type: "message",
            id: "m2",
            message: { role: "assistant", text: "hi" },
          }),
        ].join("\n"),
      );
      // Phase 1: unknown prefix is rejected (nothing cleared yet).
      const miss = scriptedIo(["/resume zzz", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, miss);
      const missStatuses = miss.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(missStatuses.some((t) => t.includes("no session matches: zzz"))).toBe(true);

      // Phase 2: resume by unique prefix (clears the transcript), then list
      // last so the listing statuses survive in the final state.
      const io = scriptedIo(["/resume aaaaaaaa", "/resume", "/exit"]);
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      expect(code).toBe(0);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      // Listing shows the seeded id; the auto title replaces the raw preview
      expect(statuses.some((t) => t.includes(seed))).toBe(true);
      expect(statuses.some((t) => t.includes("Greet resume"))).toBe(true);
      expect(statuses.some((t) => t.includes("hello resume"))).toBe(false);
      // Unique prefix resumes: 2 messages loaded (title event is not a message)
      expect(statuses.some((t) => t.includes(`resumed session: ${seed} (2 messages)`))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("failed first turn (max steps) persists context for the next turn", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-maxstep-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_MAX_STEPS = "2"; // first turn fails with max steps exceeded
    const seen: string[][][] = [];
    try {
      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider({
        id: "probe",
        name: "Probe",
        getModels: () => [
          {
            id: "m",
            name: "M",
            provider: "probe",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
        async *stream(_model, messages) {
          seen.push(messages.map((m) => [m.role, m.text ?? ""]));
          const toolCount = messages.filter((m) => m.role === "assistant" && m.text === "").length;
          yield { delta: { type: "tool_use", id: `t${toolCount}`, name: "bash" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: `t${toolCount}`,
              partial_json: JSON.stringify({ command: "echo hi" }),
            },
          };
          yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
          yield { stopReason: "tool_use" };
        },
      });
      const io = scriptedIo(["first task", "continue"]);
      const code = await runTuiSession({ modelRuntime, workspaceRoot: sessionDir }, io);
      expect(code).toBe(0);
      // The second turn's model input carries the first turn's tool trail
      // (assistant tool_use + tool_result), not just the user prompt.
      const second = seen.find((msgs) =>
        msgs.some(([role, text]) => role === "user" && text === "continue"),
      );
      expect(second).toBeDefined();
      const roles = second?.map(([role]) => role) ?? [];
      expect(roles).toContain("tool");
      expect(roles.filter((r) => r === "assistant").length).toBeGreaterThan(0);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_MAX_STEPS;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("session file is written in real time while the run is live", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-realtime-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      const modelRuntime = createModelRuntime();
      modelRuntime.registerProvider({
        id: "probe",
        name: "Probe",
        getModels: () => [
          {
            id: "m",
            name: "M",
            provider: "probe",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
          },
        ],
        async *stream(_model, messages) {
          const hasTool = messages.some((m) => m.role === "tool");
          if (!hasTool) {
            yield { delta: { type: "tool_use", id: "t1", name: "bash" } };
            yield {
              delta: {
                type: "input_json_delta",
                id: "t1",
                partial_json: JSON.stringify({ command: "echo hi" }),
              },
            };
            yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
            yield { stopReason: "tool_use" };
            return;
          }
          yield { delta: { type: "text", text: "done" } };
          yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
        },
      });
      const io = scriptedIo(["do a tool"]);
      // Run in background; once the run has rendered a live tool event, the
      // real-time hook has already written the user prompt + tool_use to the
      // session file (a killed process would still leave the trail).
      const done = runTuiSession({ modelRuntime, workspaceRoot: sessionDir }, io);
      const readRoles = (): string[] => {
        const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
        if (files.length === 0) return [];
        // Durable-format boundary: each line is our own JSONL event shape.
        const events = readFileSync(join(sessionDir, files[0]!), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { message?: { role?: string } });
        return events.map((e) => e.message?.role ?? "");
      };
      // While the tool is executing: the user prompt is already on disk —
      // killing the process here still leaves the question behind.
      await io.toolRendered;
      expect(readRoles()).toContain("user");
      // After the run settles: the full trail (tool_use + tool_result) is
      // on disk too.
      await done;
      const roles = readRoles();
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("/resume all lists sessions from other workspaces", async () => {
    const agentRoot = mkdtempSync(join(tmpdir(), "oma-tui-resume-all-"));
    const savedSessionDir = process.env.OMA_SESSION_DIR;
    delete process.env.OMA_SESSION_DIR; // exercise the default per-workspace layout
    process.env.OMA_CODING_AGENT_DIR = agentRoot;
    const currentCwd = process.cwd();
    const foreignCwd = "/tmp/foreign-workspace";
    try {
      const localSeed = "local-0000-0000-0000-000000000001";
      const foreignSeed = "foreign-0000-0000-0000-000000000002";
      const localDir = sessionDirFor(currentCwd);
      const foreignDir = sessionDirFor(foreignCwd);
      mkdirSync(localDir, { recursive: true });
      mkdirSync(foreignDir, { recursive: true });
      writeFileSync(
        join(localDir, `${localSeed}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: localSeed, timestamp: new Date().toISOString(), cwd: currentCwd })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", text: "local question" } })}\n`,
      );
      writeFileSync(
        join(foreignDir, `${foreignSeed}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: foreignSeed, timestamp: new Date().toISOString(), cwd: foreignCwd })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", text: "foreign question" } })}\n`,
      );

      // /resume all falls back to the text listing (scriptedIo has no
      // pickSession) and must show the foreign workspace marker.
      const io = scriptedIo(["/resume all", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: currentCwd }, io);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      const listing = statuses.find((t) => t.includes(foreignSeed));
      expect(listing).toBeDefined();
      expect(listing).toContain(`[${foreignCwd}]`);
      expect(listing).toContain("foreign question");
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      if (savedSessionDir === undefined) delete process.env.OMA_SESSION_DIR;
      else process.env.OMA_SESSION_DIR = savedSessionDir;
      rmSync(agentRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

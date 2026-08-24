import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { registerBuiltinProviders } from "../../core/run-runtime.js";
import { sessionDirFor } from "../../core/session-file.js";
import { formatModelMeta, runTuiSession, type TuiIo } from "./tui-mode.js";
import { addUserInput, applyEvent, initialViewState, type TuiViewState } from "./view-state.js";

/** Scripted TuiIo: feeds idle inputs sequentially, captures renders.
 *  Live submits (during a run) are recorded and forwarded to the handler. */
function scriptedIo(inputs: string[]): TuiIo & {
  renders: TuiViewState[];
  live: string[];
  liveCommands: string[];
  headers: Array<{ model?: string; sessionId?: string; title?: string; context?: string }>;
  toolRendered: Promise<void>;
  submitLive: (text: string) => void;
  sendLiveCommand: (text: string) => void;
} {
  const renders: TuiViewState[] = [];
  const live: string[] = [];
  const liveCommands: string[] = [];
  const headers: Array<{ model?: string; sessionId?: string; title?: string; context?: string }> =
    [];
  let i = 0;
  let liveHandler: ((text: string) => void) | null = null;
  let liveCommandHandler: ((text: string) => void) | null = null;
  const { promise: toolRendered, resolve: markToolRendered } = Promise.withResolvers<void>();
  return {
    renders,
    live,
    liveCommands,
    headers,
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
    onLiveCommand: (handler) => {
      liveCommandHandler = handler;
    },
    setHeader: (info) => {
      headers.push(info);
    },
    // ponytail: tests push live submits through this hook rather than
    // simulating keystroke timing.
    submitLive: (text: string) => {
      live.push(text);
      liveHandler?.(text);
    },
    sendLiveCommand: (text: string) => {
      liveCommands.push(text);
      liveCommandHandler?.(text);
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

  test("queue_update settles a steered echo after the tools that ran", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    // Steer echo submitted mid-run (pending » item in its own run entry).
    addUserInput(state, "fix the flag", true);
    // A tool renders after the echo was submitted but before the drain.
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "ok", isError: false },
    });
    // The loop drains the steer: the echo settles at the injection point.
    applyEvent(state, { type: "queue_update", drained: ["fix the flag"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "fix the flag" });
    expect(users[0]?.pending).toBeFalsy();
    // The settled user item sits AFTER the tool item (pi renders the user
    // message when the loop takes it, not where it was typed).
    const flat = state.runs.flatMap((r) => r.items.map((i) => i.kind));
    expect(flat.indexOf("tool")).toBeLessThan(flat.lastIndexOf("user"));
  });

  test("queue_update without a matching echo changes nothing", () => {
    const state = initialViewState();
    addUserInput(state, "typed", true);
    applyEvent(state, { type: "queue_update", drained: ["never echoed"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]?.pending).toBe(true);
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

  test("workflow events fold into transcript statuses", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "workflow_started", workflowId: "w", label: "audit", agentCount: 3 });
    applyEvent(state, {
      type: "workflow_agent_completed",
      workflowId: "w",
      agentId: "a",
      label: "one",
      ok: true,
    });
    applyEvent(state, {
      type: "workflow_agent_completed",
      workflowId: "w",
      agentId: "b",
      label: "two",
      ok: false,
      error: "boom",
    });
    applyEvent(state, {
      type: "workflow_completed",
      workflowId: "w",
      ok: true,
      agentCount: 2,
      totalTokens: 123,
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const statuses = state.runs[0]!.items.filter(
      (i) => i.kind === "status" || i.kind === "error",
    ).map((i) => i.text);
    expect(statuses.some((t) => t.includes("audit (3 agents)"))).toBe(true);
    expect(statuses.some((t) => t.includes("one"))).toBe(true);
    expect(statuses.some((t) => t.includes("two: boom"))).toBe(true);
    expect(statuses.some((t) => t.includes("123 tokens"))).toBe(true);
  });

  test("initial view state hides thinking detail and tool detail", () => {
    const state = initialViewState();
    expect(state.showThinking).toBe(false);
    expect(state.showToolDetail).toBe(false);
  });
});

describe("formatModelMeta", () => {
  const base = { displayName: "Fake Echo", contextWindow: 200_000 };

  test("name, context window, free when cost legs are zero", () => {
    expect(formatModelMeta(base)).toBe("Fake Echo · ctx 200k · free");
    expect(formatModelMeta({ ...base, cost: { input: 3, output: 15 } })).toBe(
      "Fake Echo · ctx 200k · $3/15",
    );
  });

  test("current mark and over-context warning", () => {
    expect(formatModelMeta(base, { current: true })).toContain("current");
    expect(formatModelMeta({ ...base, contextWindow: 1_000 }, { contextTokens: 2_000 })).toContain(
      "over current context!",
    );
    // Window larger than the session: no warning.
    expect(formatModelMeta(base, { contextTokens: 2_000 })).not.toContain("over current context");
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
      const inputs = ["hi", "/exit", "/exit"];
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
      const io = scriptedIo(["/session", "/model fake/echo", "/exit", "/exit"]);
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
    // Pin the agent dir so a developer's ~/.oma/skills cannot change the
    // auto-registered skill command count.
    const agentDir = mkdtempSync(join(tmpdir(), "oma-tui-cmd-agent-"));
    process.env.OMA_CODING_AGENT_DIR = agentDir;
    const registered: number[] = [];
    try {
      const base = scriptedIo([
        "/help",
        "/nonsense",
        "/models",
        "/model fake/missing",
        "/exit",
        "/exit",
      ]);
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
      // 17 static commands (incl. /mcp, /skill, /workflow); the pinned
      // agent dir guarantees zero auto-registered skills.
      expect(registered).toEqual([17]);
      const statuses = base.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      // /help lists the commands
      expect(statuses.some((t) => t.includes("/help"))).toBe(true);
      expect(statuses.some((t) => t.includes("/abort"))).toBe(true);
      // unknown command hints at /help
      expect(statuses.some((t) => t.includes("unknown command /nonsense"))).toBe(true);
      // /models (alias) lists the catalog with the meta line (ctx + free)
      expect(statuses.some((t) => t.includes("fake/echo"))).toBe(true);
      expect(statuses.some((t) => t.includes("ctx 200k"))).toBe(true);
      expect(statuses.some((t) => t.includes("free"))).toBe(true);
      // /model with an id not in the catalog is rejected
      expect(statuses.some((t) => t.includes("unknown model: fake/missing"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("/skill lists and auto-registers skill commands", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "oma-tui-skills-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-skills-sess-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "oma-tui-skills-agent-"));
    try {
      mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
      writeFileSync(
        join(workspace, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo skill for tests\n---\nBody.\n",
        "utf8",
      );
      const io = scriptedIo(["/skill", "/skill:demo do the thing", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: workspace }, io);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("/skill:demo — Demo skill for tests"))).toBe(true);
      // The auto-registered command submitted a real run pointing at the skill.
      const texts = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.map((i) => i.text))
        .join("");
      expect(texts).toContain('follow the "demo" skill');
      expect(texts).toContain("done");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("/workflow runs an inline vm script and renders the result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "oma-tui-wf-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-wf-sess-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "oma-tui-wf-agent-"));
    try {
      const io = scriptedIo(["/workflow return 40+2", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: workspace }, io);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("workflow: script"))).toBe(true);
      expect(statuses.some((t) => t.includes("workflow done"))).toBe(true);
      expect(statuses.some((t) => t.includes("workflow result: 42"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("/mcp lists .mcp.json servers and tests one", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "oma-tui-mcp-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-mcp-sess-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "oma-tui-mcp-agent-"));
    const serverPath = join(import.meta.dir, "../../core/__fixtures__/mcp-echo-server.ts");
    try {
      writeFileSync(
        join(workspace, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "echo-server": { command: "bun", args: [serverPath] },
            broken: { nope: true },
          },
        }),
        "utf8",
      );
      const io = scriptedIo([
        "/mcp",
        "/mcp test echo-server",
        "/mcp test missing",
        "/exit",
        "/exit",
      ]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: workspace }, io);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("echo-server [stdio]"))).toBe(true);
      expect(statuses.some((t) => t.includes("broken [invalid]"))).toBe(true);
      expect(statuses.some((t) => t.includes("echo-server: ok · 1 tools (echo)"))).toBe(true);
      expect(statuses.some((t) => t.includes("missing: FAILED"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 30_000);

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
      const miss = scriptedIo(["/resume zzz", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, miss);
      const missStatuses = miss.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(missStatuses.some((t) => t.includes("no session matches: zzz"))).toBe(true);

      // Phase 2: resume by unique prefix (clears the transcript), then list
      // last so the listing statuses survive in the final state.
      const io = scriptedIo(["/resume aaaaaaaa", "/resume", "/exit", "/exit"]);
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

  test("memory learn indicator shows learning then learned facts", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-learn-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    const savedTitle = process.env.OMA_TITLE_ENABLED;
    process.env.OMA_TITLE_ENABLED = "0"; // keep model-call count deterministic
    try {
      const replies = [
        "done",
        JSON.stringify({ facts: [{ content: "JWT expiry is 15m", context: "auth" }] }),
        "## Key Decisions",
      ];
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
        async *stream() {
          const reply = replies.shift() ?? "";
          yield { delta: { type: "text", text: reply } };
          yield { stopReason: "end_turn" };
        },
      });
      const io = scriptedIo(["hello"]);
      await runTuiSession({ modelRuntime, workspaceRoot: sessionDir }, io);
      const statusTexts = (): string[] =>
        io.renders
          .at(-1)!
          .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
          .map((i) => i.text);
      // The learn pass is background fire-and-forget: drain microtasks (the
      // fake provider resolves without timers) until the result status lands.
      let statuses = statusTexts();
      for (let i = 0; i < 5_000; i++) {
        if (statuses.some((t) => t !== "memory: learning…" && t.startsWith("memory: "))) break;
        await Promise.resolve();
        statuses = statusTexts();
      }
      // omp AutoLearn-style indicator: the result replaces the in-flight
      // "learning…" line (no fossil left in the permanent transcript).
      expect(statuses).toContain("memory: learned 1 fact");
      expect(statuses).not.toContain("memory: learning…");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      if (savedTitle === undefined) delete process.env.OMA_TITLE_ENABLED;
      else process.env.OMA_TITLE_ENABLED = savedTitle;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);

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
      const io = scriptedIo(["/resume all", "/exit", "/exit"]);
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

  test("/exit requires a second confirmation", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-exit-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    try {
      // First /exit only arms the confirm; the session keeps running.
      const io = scriptedIo(["/exit", "/session", "/exit", "/exit"]);
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      expect(code).toBe(0);
      const statuses = io.renders
        .at(-1)!
        .runs.flatMap((r) => r.items.filter((i) => i.kind === "status"))
        .map((i) => i.text);
      expect(statuses.some((t) => t.includes("type /exit again to quit"))).toBe(true);
      // /session still worked after the first /exit -> not exited yet.
      expect(statuses.some((t) => t.includes("session:"))).toBe(true);
    } finally {
      delete process.env.OMA_SESSION_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }, 15_000);

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
      expect(statuses.some((t) => t.includes("terminal was unfocused"))).toBe(true);
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

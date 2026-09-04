import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { sessionDirFor } from "../../core/session/session-file.js";
import { scriptedIo, testModelRuntime } from "./tui-mode.fixture.js";
import { runTuiSession } from "./tui-mode.js";

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
      expect(registered).toEqual([20]);
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
  test("/model persists the choice to project settings and a fresh session reuses it", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-model-persist-"));
    const agentDir = mkdtempSync(join(tmpdir(), "oma-tui-model-persist-agent-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_CODING_AGENT_DIR = agentDir;
    try {
      // Select a model via /model; it must land in .oma/settings.json.
      const sel = scriptedIo(["/model fake/echo2", "/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, sel);
      const settings = JSON.parse(readFileSync(join(sessionDir, ".oma", "settings.json"), "utf8"));
      expect(settings.model).toBe("fake/echo2");

      // A new TUI session reads the saved model as its default header model.
      const boot = scriptedIo(["/exit", "/exit"]);
      await runTuiSession({ modelRuntime: testModelRuntime(), workspaceRoot: sessionDir }, boot);
      expect(boot.headers[0]?.model).toBe("fake/echo2");
    } finally {
      delete process.env.OMA_SESSION_DIR;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 15_000);
  test("/model switch then a normal prompt settles and surfaces output", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "oma-tui-model-run-"));
    const agentDir = mkdtempSync(join(tmpdir(), "oma-tui-model-run-agent-"));
    process.env.OMA_SESSION_DIR = sessionDir;
    process.env.OMA_CODING_AGENT_DIR = agentDir;
    try {
      const io = scriptedIo(["/model fake/echo2", "hi", "/exit", "/exit"]);
      const code = await runTuiSession(
        { modelRuntime: testModelRuntime(), workspaceRoot: sessionDir },
        io,
      );
      expect(code).toBe(0);
      const last = io.renders.at(-1)!;
      // No live run remains: the busy "working" state must settle.
      expect(last.runs.every((r) => r.running === false)).toBe(true);
      const texts = last.runs.flatMap((r) => r.items.map((i) => i.text));
      // The assistant output rendered, not just a stuck spinner.
      expect(texts.some((t) => t.includes("done"))).toBe(true);
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
      mkdirSync(join(workspace, ".oma", "skills", "demo"), { recursive: true });
      writeFileSync(
        join(workspace, ".oma", "skills", "demo", "SKILL.md"),
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
      // The resumed transcript surfaces the saved history (user + assistant).
      const resumedItems = io.renders.at(-1)!.runs.flatMap((r) => r.items);
      expect(resumedItems.some((i) => i.kind === "user" && i.text === "hello resume")).toBe(true);
      expect(resumedItems.some((i) => i.kind === "assistant" && i.text === "hi")).toBe(true);
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
});

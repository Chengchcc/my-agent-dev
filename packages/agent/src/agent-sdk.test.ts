import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";
import { createAgentSession } from "./agent-sdk.js";
import type { AgentExtensionFactory, AgentScope } from "./extension-host.js";
import { composeExtensions } from "./extension-host.js";
import type { ModelRuntime } from "./model-runtime.js";
import { resolveModel } from "./model-runtime.js";

const scope: AgentScope = { agentId: "a", sessionId: "s", cwd: "/tmp" };

describe("createAgentSession", () => {
  test("ChatModel directly creates an Agent", async () => {
    const agent = await createAgentSession({
      scope,
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.state).toBe("idle");
  });

  test("ModelRef + ModelRuntime creates an Agent", async () => {
    const runtime: ModelRuntime = {
      resolve: (ref) => ({
        id: ref,
        provider: ref.split("/")[0] ?? "?",
        name: ref.split("/")[1] ?? "?",
        chatModel: echoModel({ turns: [{ type: "text", text: ref }] }),
      }),
    };
    const agent = await createAgentSession({
      scope,
      model: "test/custom",
      modelRuntime: runtime,
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  test("ModelRef without ModelRuntime throws", async () => {
    await expect(createAgentSession({ scope, model: "anthropic/claude" })).rejects.toThrow(
      "requires a ModelRuntime",
    );
  });

  test("extensions resolve in registration order", async () => {
    const calls: string[] = [];
    const f1: AgentExtensionFactory = {
      id: "first",
      create: async () => {
        calls.push("first");
        return { id: "first" };
      },
    };
    const f2: AgentExtensionFactory = {
      id: "second",
      create: async () => {
        calls.push("second");
        return { id: "second" };
      },
    };
    await createAgentSession({
      scope,
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      extensions: [f1, f2],
    });
    expect(calls).toEqual(["first", "second"]);
  });

  test("async extension failure propagates", async () => {
    const f: AgentExtensionFactory = {
      id: "fail",
      create: async () => {
        throw new Error("init failed");
      },
    };
    await expect(
      createAgentSession({
        scope,
        model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
        extensions: [f],
      }),
    ).rejects.toThrow("init failed");
  });

  test("scope is passed to each extension", async () => {
    const scopes: AgentScope[] = [];
    const f: AgentExtensionFactory = {
      id: "s",
      create: (s) => {
        scopes.push({ ...s });
        return { id: "s" };
      },
    };
    await createAgentSession({
      scope: { agentId: "a1", sessionId: "s1", cwd: "/w" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      extensions: [f],
    });
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.agentId).toBe("a1");
  });

  test("tool collision propagates", async () => {
    const t = {
      name: "dup",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }),
    };
    await expect(
      createAgentSession({
        scope,
        model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
        extensions: [
          { id: "a", create: () => ({ id: "a", tools: [t] }) },
          { id: "b", create: () => ({ id: "b", tools: [{ ...t }] }) },
        ],
      }),
    ).rejects.toThrow("Tool name collision");
  });

  test("base + extension tools merge cleanly", async () => {
    const bt = {
      name: "base",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }),
    };
    const et = {
      name: "ext",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }),
    };
    const agent = await createAgentSession({
      scope,
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      extensions: [{ id: "e", create: () => ({ id: "e", tools: [et] }) }],
      tools: [bt],
    });
    expect(agent).toBeInstanceOf(Agent);
  });
  // ── Production wiring smoke: createAgentSession() + SessionManager ──
  test("SessionManager.create called via createAgentSession (no sessionId)", async () => {
    let createCalled = false;
    const sm = {
      create: (cfg: unknown) => { createCalled = true; return new Agent(cfg as never); },
      open: () => { throw new Error("should not open"); },
      get: () => undefined,
      dispose: () => {},
    };
    const agent = await createAgentSession({
      scope: { agentId: "a", cwd: "/tmp" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionManager: sm,
    });
    expect(agent).toBeInstanceOf(Agent);
    expect(createCalled).toBe(true);
  });

  test("SessionManager.open called via createAgentSession (existing sessionId)", async () => {
    let openedSid = "";
    const sm = {
      create: () => { throw new Error("should not create"); },
      open: (sid: string, cfg: unknown) => { openedSid = sid; return new Agent(cfg as never); },
      get: () => undefined,
      dispose: () => {},
    };
    await createAgentSession({
      scope: { agentId: "a", sessionId: "reuse-me", cwd: "/tmp" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionManager: sm,
    });
    expect(openedSid).toBe("reuse-me");
  });

  test("SessionManager.create receives valid AgentConfig with hooks + tools", async () => {
    let captured: unknown = undefined;
    const sm = {
      create: (cfg: unknown) => { captured = cfg; return new Agent(cfg as never); },
      open: () => { throw new Error("no"); },
      get: () => undefined,
      dispose: () => {},
    };
    const t = { name: "t1", description: "d", inputSchema: {}, execute: async () => ({ role: "tool" as const, id: "x", name: "t1", content: "ok" }) };
    await createAgentSession({
      scope: { agentId: "a", cwd: "/tmp" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionManager: sm,
      extensions: [{ id: "e", create: () => ({ id: "e", systemPrompt: "E" }) }],
      tools: [t],
      systemPrompt: "base",
    });
    const cfg = captured as Record<string, unknown>;
    expect(cfg.model).toBeDefined();
    expect(Array.isArray(cfg.tools)).toBe(true);
    expect(cfg.systemPrompt).toBeDefined();
  });

});

describe("resolveModel", () => {
  test("ChatModel returns custom ResolvedModel", async () => {
    const cm = echoModel({ turns: [{ type: "text", text: "hi" }] });
    const resolved = await resolveModel(cm);
    expect(resolved.id).toBe("custom");
    expect(resolved.provider).toBe("custom");
  });

  test("ModelRef throws without runtime", async () => {
    await expect(resolveModel("anthropic/claude")).rejects.toThrow("requires a ModelRuntime");
  });

  test("ModelRef resolves via runtime", async () => {
    const runtime: ModelRuntime = {
      resolve: (ref) => ({
        id: ref,
        provider: "test",
        name: "model",
        chatModel: echoModel({ turns: [] }),
      }),
    };
    const resolved = await resolveModel("test/model", runtime);
    expect(resolved.id).toBe("test/model");
  });
});

describe("composeExtensions contract", () => {
  test("base prompt prefixed before extension prompts", () => {
    const c = composeExtensions({
      resolved: [
        { id: "a", extension: { id: "a", systemPrompt: "ext-a" } },
        { id: "b", extension: { id: "b", systemPrompt: "ext-b" } },
      ],
      baseTools: [],
      baseSystemPrompt: "base",
    });
    expect(c.systemPrompt).toBe("base\n\next-a\n\next-b");
  });

  test("base prompt appears exactly once", () => {
    const c = composeExtensions({
      resolved: [{ id: "a", extension: { id: "a", systemPrompt: "ext" } }],
      baseTools: [],
      baseSystemPrompt: "base",
    });
    expect(c.systemPrompt?.split("\n\n").filter((p) => p === "base").length).toBe(1);
  });

  test("composeExtensions returns required id", () => {
    expect(
      composeExtensions({ resolved: [{ id: "x", extension: { id: "x" } }], baseTools: [] }).id,
    ).toBe("composed");
  });
});

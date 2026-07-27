import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";
import { resolveModel } from "./model-runtime.js";
import type { ModelRuntime } from "./model-runtime.js";
import { createAgentSession } from "./agent-sdk.js";

describe("createAgentSession (P7-0 thin facade)", () => {
  test("ChatModel directly creates an Agent", async () => {
    const agent = await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.state).toBe("idle");
  });

  test("ModelRef + ModelRuntime creates an Agent", async () => {
    const runtime: ModelRuntime = {
      resolve: (ref) => ({
        id: ref,
        provider: "test",
        name: "test",
        chatModel: echoModel({ turns: [{ type: "text", text: ref }] }),
      }),
    };
    const agent = await createAgentSession({
      model: "test/model",
      modelRuntime: runtime,
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  test("ModelRef without ModelRuntime throws", async () => {
    await expect(createAgentSession({ model: "anthropic/claude" })).rejects.toThrow(
      "requires a ModelRuntime",
    );
  });

  test("plugins are passed through", async () => {
    const plugin = { name: "test", hooks: {} };
    const agent = await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      plugins: [plugin],
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  test("tools are passed through", async () => {
    const t = {
      name: "t1",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t1", content: "ok" }),
    };
    const agent = await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      tools: [t],
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  test("sessionManager.create called without sessionId", async () => {
    let created = false;
    const sm = {
      create: () => {
        created = true;
        return new Agent({ model: echoModel({ turns: [] }) });
      },
      open: () => {
        throw new Error("no");
      },
      get: () => undefined,
      dispose: () => {},
    };
    await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionManager: sm,
    });
    expect(created).toBe(true);
  });

  test("sessionManager.open called with sessionId", async () => {
    let opened = "";
    const sm = {
      create: () => {
        throw new Error("no");
      },
      open: (sid: string) => {
        opened = sid;
        return new Agent({ model: echoModel({ turns: [] }) });
      },
      get: () => undefined,
      dispose: () => {},
    };
    await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionManager: sm,
      sessionId: "existing-session",
    });
    expect(opened).toBe("existing-session");
  });

  test("metaContext + systemPrompt are forwarded", async () => {
    const agent = await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      systemPrompt: "base",
      metaContext: () => "meta",
    });
    expect(agent).toBeInstanceOf(Agent);
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

import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { createAgentSession } from "@my-agent-team/agent";
import type { AgentExtensionFactory } from "@my-agent-team/agent";
import { CapabilityRegistry } from "./registry.js";

describe("P6-C SDK integration", () => {
  test("registry.extensionFactories() → createAgentSession() → Agent", async () => {
    // 1. Register capabilities
    const reg = new CapabilityRegistry();
    reg.register({
      id: "identity",
      extendAgent: () => ({ id: "identity", systemPrompt: "You are an agent." }),
    });
    reg.register({
      id: "skill",
      extendAgent: () => ({ id: "skill", systemPrompt: "skills loaded" }),
    });

    // 2. Get factories
    const factories: readonly AgentExtensionFactory[] = reg.extensionFactories();

    // 3. Create agent via SDK
    let openedSid = "";
    const agent = await createAgentSession({
      scope: { agentId: "a1", sessionId: "reuse", cwd: "/tmp" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      extensions: factories,
      sessionManager: {
        create: () => { throw new Error("should not create"); },
        open: (sid, cfg) => { openedSid = sid; return new (require("@my-agent-team/agent").Agent)(cfg as never); },
        get: () => undefined,
        dispose: () => {},
      },
      systemPrompt: "base prompt",
    });

    expect(openedSid).toBe("reuse");
    expect(agent).toBeDefined();
  });

  test("factories resolve scope via createAgentSession", async () => {
    const reg = new CapabilityRegistry();
    let receivedCwd = "";
    reg.register({
      id: "scope-check",
      extendAgent: (s) => { receivedCwd = s.cwd; return { id: "scope-check" }; },
    });

    await createAgentSession({
      scope: { agentId: "a1", sessionId: "s1", cwd: "/workspace" },
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      extensions: reg.extensionFactories(),
    });

    expect(receivedCwd).toBe("/workspace");
  });
});

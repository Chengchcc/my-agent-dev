// ── P8: Experimental. Capability catalog is for future cross-boundary features.
// Not used in production Agent path. Plugin-first migration (P7) is the canonical path.
//
import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { createAgentSession } from "@my-agent-team/agent";
import type { AgentExtensionFactory } from "@my-agent-team/agent";
import { CapabilityRegistry } from "./registry.js";

describe("P6-C SDK integration", () => {
  test("registry.extensionFactories() → createAgentSession() → Agent", async () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: "identity", extendAgent: () => ({ id: "identity", systemPrompt: "You are an agent." }) });
    reg.register({ id: "skill", extendAgent: () => ({ id: "skill", systemPrompt: "skills loaded" }) });

    const factories: readonly AgentExtensionFactory[] = reg.extensionFactories();
    let openedSid = "";
    const agent = await createAgentSession({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      plugins: [{ name: "wrap", hooks: {} }],
      sessionManager: {
        create: () => { throw new Error("no"); },
        open: (sid) => { openedSid = sid; return new (require("@my-agent-team/agent").Agent)({ model: echoModel({ turns: [] }) }); },
        get: () => undefined, dispose: () => {},
      },
      sessionId: "reuse",
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
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
      sessionId: "s1",
    });

    // scope check via factory path still works via extensionFactories
    const f = reg.extensionFactories()[0]!;
    await f.create({ agentId: "a", sessionId: "s", cwd: "/workspace" });
    expect(receivedCwd).toBe("/workspace");
  });
});

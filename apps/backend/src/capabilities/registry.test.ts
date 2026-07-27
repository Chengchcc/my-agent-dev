import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "./registry.js";
import type {
  AgentExtension,
  AgentScope,
  BackendInfrastructure,
  Capability,
  MemoryCapabilityDeps,
  MemoryReader,
} from "./types.js";

const scope: AgentScope = { agentId: "a", sessionId: "s", cwd: "/tmp" };

describe("CapabilityRegistry", () => {
  test("empty registry list is empty", () => {
    expect(new CapabilityRegistry().list().length).toBe(0);
  });

  test("install order is deterministic", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "c" });
    r.register({ id: "a" });
    r.register({ id: "b" });
    expect(r.list().map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  test("duplicate ids rejected", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "x" });
    expect(() => r.register({ id: "x" })).toThrow("Duplicate");
  });

  test("extension factories produce AgentExtension", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "a", extendAgent: () => ({ id: "a", systemPrompt: "A" }) });
    r.register({ id: "b", extendAgent: () => ({ id: "b", systemPrompt: "B" }) });
    const factories = r.extensionFactories();
    expect(factories).toHaveLength(2);
    const e1 = await factories[0]!.create(scope);
    const e2 = await factories[1]!.create(scope);
    expect(e1.systemPrompt).toBe("A");
    expect(e2.systemPrompt).toBe("B");
  });

  test("extension factory assigns capability id", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "test-id", extendAgent: () => ({ systemPrompt: "x" }) });
    const f = r.extensionFactories()[0]!;
    expect(f.id).toBe("test-id");
    const ext = await f.create(scope);
    expect(ext.id).toBe("test-id");
  });

  test("awaits async extensions", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "x", extendAgent: async () => ({ id: "x", systemPrompt: "async-ok" }) });
    const f = r.extensionFactories()[0]!;
    expect((await f.create(scope)).systemPrompt).toBe("async-ok");
  });

  test("propagates async rejection", async () => {
    const r = new CapabilityRegistry();
    r.register({
      id: "fail",
      extendAgent: async () => {
        throw new Error("boom");
      },
    });
    const f = r.extensionFactories()[0]!;
    await expect(f.create(scope)).rejects.toThrow("boom");
  });

  test("passes real scope to extension", async () => {
    const r = new CapabilityRegistry();
    let received: AgentScope | undefined;
    r.register({
      id: "s",
      extendAgent: (s) => {
        received = { ...s };
        return { id: "s" };
      },
    });
    await r.extensionFactories()[0]!.create({ agentId: "a1", sessionId: "s1", cwd: "/w" });
    expect(received).toEqual({
      agentId: "a1",
      sessionId: "s1",
      conversationId: "c1",
      memberId: "m1",
      cwd: "/w",
    });
  });

  test("scope is not leaked between calls", async () => {
    const r = new CapabilityRegistry();
    const scopes: AgentScope[] = [];
    r.register({
      id: "x",
      extendAgent: (s) => {
        scopes.push({ ...s });
        return { id: "x" };
      },
    });
    const f = r.extensionFactories()[0]!;
    await f.create({ agentId: "a", sessionId: "1", cwd: "/a" });
    await f.create({ agentId: "b", sessionId: "2", cwd: "/b" });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]?.sessionId).toBe("1");
    expect(scopes[1]?.sessionId).toBe("2");
  });

  test("installs server for all capabilities", async () => {
    const r = new CapabilityRegistry();
    const calls: string[] = [];
    r.register({
      id: "a",
      installServer: async () => {
        calls.push("a");
      },
    });
    r.register({
      id: "b",
      installServer: async () => {
        calls.push("b");
      },
    });
    await r.installServer({ registerRoute: () => {}, registerCommand: () => {} });
    expect(calls).toEqual(["a", "b"]);
  });

  test("async installServer failure propagates", async () => {
    const r = new CapabilityRegistry();
    r.register({
      id: "fail",
      installServer: async () => {
        throw new Error("install failed");
      },
    });
    await expect(
      r.installServer({ registerRoute: () => {}, registerCommand: () => {} }),
    ).rejects.toThrow("install failed");
  });

  test("getManifests returns all in order", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "a", manifest: { id: "a", slots: ["sidebar"] } });
    r.register({ id: "b" });
    const m = r.getManifests();
    expect(m).toHaveLength(2);
    expect(m[0]?.slots).toEqual(["sidebar"]);
    expect(m[1]?.slots).toBeUndefined();
  });
});

// ── P6-B: Services ownership ──
describe("P6-B dependency ownership", () => {
  function fakeInfra(): BackendInfrastructure {
    return {
      modelRegistry: { get: () => ({ stream: async function* () {} }) as never },
      settings: { get: () => undefined, getNumber: async () => undefined, set: () => {} },
      fs: { cwd: "/tmp", read: () => "", write: () => {} },
      sse: { emit: () => {} },
    };
  }

  test("factory closure captures deps and reuses service across scopes", async () => {
    const infra = fakeInfra();
    let factoryCalls = 0;
    let extendCalls = 0;

    function createFakeCapability(deps: MemoryCapabilityDeps): Capability {
      factoryCalls++;
      const calls: string[] = [];
      return {
        id: "fake-memory",
        extendAgent(scope: AgentScope) {
          extendCalls++;
          calls.push(scope.sessionId);
          return { id: "fake", systemPrompt: `agent=${scope.agentId} fs=${deps.fs.cwd}` };
        },
      };
    }

    const cap = createFakeCapability({
      modelRegistry: infra.modelRegistry,
      settings: infra.settings,
      fs: infra.fs,
    });
    const reg = new CapabilityRegistry();
    reg.register(cap);
    expect(factoryCalls).toBe(1);

    const f = reg.extensionFactories()[0]!;
    const e1 = await f.create({ agentId: "a", sessionId: "s1", cwd: "/a" });
    const e2 = await f.create({ agentId: "b", sessionId: "s2", cwd: "/b" });
    expect(extendCalls).toBe(2);
    expect(e1.systemPrompt).toContain("agent=a");
    expect(e2.systemPrompt).toContain("agent=b");
  });

  test("capability only receives declared deps, not full infra", () => {
    const infra = fakeInfra();
    const deps: MemoryCapabilityDeps = {
      modelRegistry: infra.modelRegistry,
      settings: infra.settings,
      fs: infra.fs,
    };
    expect(deps.modelRegistry).toBeDefined();
    expect(deps.settings).toBeDefined();
    expect(deps.fs).toBeDefined();
    expect("sse" in deps).toBe(false);
  });

  test("MemoryReader narrow port works", async () => {
    const reader: MemoryReader = {
      search: async (q, scope) => [{ content: `matched ${q} for ${scope.agentId}`, score: 1 }],
    };
    const results = await reader.search("test", { agentId: "a" });
    expect(results[0]?.content).toContain("test");
  });
});

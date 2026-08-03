import { describe, expect, test } from "bun:test";
import { CodingAgentBackend } from "./backend.js";
import { CodingAgentClient } from "./client.js";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (routes[path]) {
      return new Response(JSON.stringify(routes[path]), { status: 200 });
    }
    if (path.endsWith("/outcome")) {
      return new Response(JSON.stringify({ runId: "run-1", status: "completed" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "not_found", message: "nf" }), { status: 404 });
  }) as typeof fetch;
}

describe("CodingAgentBackend", () => {
  test("method set is exactly start/send/resume/respond/stop/close", () => {
    const client = new CodingAgentClient({
      baseUrl: "http://x",
      authToken: "t",
      fetchImpl: fakeFetch({}),
    });
    const backend = new CodingAgentBackend(client);
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(backend)).filter(
      (k) => k !== "constructor" && typeof (backend as Record<string, unknown>)[k] === "function",
    );
    expect(keys.sort()).toEqual(["close", "respond", "resume", "send", "start", "stop"].sort());
  });

  test("capabilities declared truthfully", () => {
    const client = new CodingAgentClient({
      baseUrl: "http://x",
      authToken: "t",
      fetchImpl: fakeFetch({}),
    });
    const backend = new CodingAgentBackend(client);
    expect(backend.kind).toBe("coding_agent");
    expect(backend.capabilities).toEqual({
      persistentSession: true,
      nativeResume: true,
      nativeSteer: true,
      thinkingStream: false,
      productTools: "mcp",
      pendingActionResponse: false,
    });
  });

  test("respond performs zero fetches", async () => {
    let fetches = 0;
    const client = new CodingAgentClient({
      baseUrl: "http://x",
      authToken: "t",
      fetchImpl: (async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const backend = new CodingAgentBackend(client);
    await expect(
      backend.respond(
        { backendSessionId: "s", backendKind: "coding_agent", runId: "r" },
        { actionId: "a", response: {} },
      ),
    ).rejects.toThrow(/does not support/);
    expect(fetches).toBe(0);
  });

  test("steer routes through send (no steer method exists)", () => {
    const client = new CodingAgentClient({
      baseUrl: "http://x",
      authToken: "t",
      fetchImpl: fakeFetch({}),
    });
    const backend = new CodingAgentBackend(client);
    expect((backend as { steer?: unknown }).steer).toBeUndefined();
    expect(typeof backend.send).toBe("function");
  });

  test("start returns session ref + segment", async () => {
    const client = new CodingAgentClient({
      baseUrl: "http://x",
      authToken: "t",
      fetchImpl: fakeFetch({
        "/v1/sessions/start": { backendSessionId: "sess-1", runId: "run-1" },
      }),
    });
    const backend = new CodingAgentBackend(client);
    const result = await backend.start({
      history: [],
      input: { inputId: "in-1", message: { role: "user", text: "go" } },
      run: {
        runId: "run-1",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: "/tmp", access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    expect(result.session.backendSessionId).toBe("sess-1");
    expect(result.session.backendKind).toBe("coding_agent");
    expect(result.segment.outcome).toBeTruthy();
    expect(typeof result.segment.stop).toBe("function");
  });
});

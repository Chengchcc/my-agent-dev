import { describe, expect, test } from "bun:test";
import type { BackendRunInput } from "@my-agent-team/agent-backend";
import { CodingAgentBackend } from "./backend.js";
import { CodingAgentClient } from "./client.js";

const INPUT: BackendRunInput<"coding_agent"> = {
  history: [{ productEntryId: "e1", message: { role: "user", text: "hi" } }],
  input: { inputId: "in-1", message: { role: "user", text: "go" } },
  run: {
    runId: "run-1",
    model: { backendKind: "coding_agent", modelId: "fake/echo" },
    productTools: [],
    configRevision: 1,
  },
  workspace: { root: "/tmp", access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};

describe("CodingAgentBackend", () => {
  test("method set is exactly execute/steer/stop", () => {
    const client = new CodingAgentClient({ baseUrl: "http://x", authToken: "t" });
    const backend = new CodingAgentBackend(client);
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(backend)).filter(
      (k) => k !== "constructor" && typeof (backend as Record<string, unknown>)[k] === "function",
    );
    expect(keys.sort()).toEqual(["execute", "steer", "stop"].sort());
  });

  test("execute posts to /v1/runs and returns a segment keyed by runId", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body });
      if (path === "/v1/runs") {
        return new Response(JSON.stringify({ runId: "run-1", accepted: true }), { status: 200 });
      }
      if (path === "/v1/runs/run-1/outcome") {
        return new Response(JSON.stringify({ runId: "run-1", status: "completed" }), {
          status: 200,
        });
      }
      if (path === "/v1/runs/run-1/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `id: 0\nevent: agent_end\ndata: ${JSON.stringify({ type: "agent_end", status: "completed" })}\n\n`,
              ),
            );
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const client = new CodingAgentClient({ baseUrl: "http://x", authToken: "t", fetchImpl });
    const backend = new CodingAgentBackend(client);
    const segment = await backend.execute(INPUT);
    expect(segment).toBeDefined();
    const events: string[] = [];
    const collect = (async () => {
      for await (const ev of segment.events) events.push(ev.type);
    })();
    const outcome = await segment.outcome;
    await collect;
    expect(outcome.status).toBe("completed");
    expect(events).toContain("status");
    expect(calls.some((c) => c.path === "/v1/runs")).toBe(true);
  });

  test("steer posts to /v1/runs/:runId/steer", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      void init;
      if (path.endsWith("/steer")) {
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const client = new CodingAgentClient({ baseUrl: "http://x", authToken: "t", fetchImpl });
    const backend = new CodingAgentBackend(client);
    await backend.steer("run-1", { inputId: "in-s", message: { role: "user", text: "steer" } });
    expect(calls).toEqual(["/v1/runs/run-1/steer"]);
  });

  test("stop posts to /v1/runs/:runId/stop", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      void init;
      if (path.endsWith("/stop")) {
        return new Response(JSON.stringify({ stopped: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const client = new CodingAgentClient({ baseUrl: "http://x", authToken: "t", fetchImpl });
    const backend = new CodingAgentBackend(client);
    await backend.stop("run-1");
    expect(calls).toEqual(["/v1/runs/run-1/stop"]);
  });

  test("segment stop uses the tracked active run", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      void init;
      if (path === "/v1/runs") {
        return new Response(JSON.stringify({ runId: "run-1", accepted: true }), { status: 200 });
      }
      if (path.endsWith("/stop")) {
        return new Response(JSON.stringify({ stopped: true }), { status: 200 });
      }
      if (path.endsWith("/outcome")) {
        return new Response(
          JSON.stringify({ runId: "run-1", status: "aborted", error: "stopped" }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const client = new CodingAgentClient({ baseUrl: "http://x", authToken: "t", fetchImpl });
    const backend = new CodingAgentBackend(client);
    const segment = await backend.execute(INPUT);
    await segment.stop();
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("aborted");
    expect(calls).toContain("/v1/runs/run-1/stop");
  });
});

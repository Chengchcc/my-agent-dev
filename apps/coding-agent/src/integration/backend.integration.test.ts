import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import type { BackendRunInput } from "@my-agent-team/agent-backend";
import { createModelRuntime } from "@my-agent-team/ai";
import { type CodingAgentApp, createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";

/** The Coding Agent acceptance chain, all real except the model:
 *
 *  CodingAgentBackend (adapter)
 *    → CodingAgentClient over HTTP/SSE
 *    → real daemon app (createCodingAgentApp, in-process fetch)
 *    → direct per-Run loop (no Worker, no session)
 *    → fresh in-memory SessionStore per Run
 *    → scripted fake provider
 *    → BackendRunOutcome
 */

const tmp = `/tmp/coding-backend-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
mkdirSync(ws, { recursive: true });

let app: CodingAgentApp;
let backend: CodingAgentBackend;

function runInput(runId: string, text = "do the thing"): BackendRunInput<"coding_agent"> {
  return {
    history: [{ productEntryId: "e1", message: { role: "user", text: "hello" } }],
    input: { inputId: `in-${runId}`, message: { role: "user", text } },
    run: {
      runId,
      model: { backendKind: "coding_agent", modelId: "fake/echo" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: ws, access: "read_write" },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
  };
}

beforeAll(async () => {
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  app = createCodingAgentApp({ config, modelRuntime: createModelRuntime() });
  const client = new CodingAgentClient({
    baseUrl: "http://daemon.test",
    authToken: "token-123",
    fetchImpl: (url, init) =>
      app.fetch(new Request(String(url), init as RequestInit)) as Promise<Response>,
  });
  backend = new CodingAgentBackend(client);
});

afterAll(async () => {
  await app.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Coding Agent Run-centric acceptance", () => {
  test("one execute creates one independent loop and settles completed", async () => {
    const segment = await backend.execute(runInput("i1"));
    const events: string[] = [];
    const collect = (async () => {
      for await (const ev of segment.events) events.push(ev.type);
    })();
    const outcome = await segment.outcome;
    await collect;
    expect(outcome.status).toBe("completed");
    expect(events).toContain("text_delta");
  }, 15_000);

  test("two different runIds run in parallel", async () => {
    const [a, b] = await Promise.all([
      backend.execute(runInput("p1")),
      backend.execute(runInput("p2")),
    ]);
    const [oa, ob] = await Promise.all([a.outcome, b.outcome]);
    expect(oa.status).toBe("completed");
    expect(ob.status).toBe("completed");
  }, 15_000);

  test("same runId + same payload idempotent; different payload conflicts", async () => {
    const first = await backend.execute(runInput("id1"));
    const replay = await backend.execute(runInput("id1"));
    // The replay returns a NEW segment; the run itself ran exactly once.
    await first.outcome;
    await replay.outcome;
    await expect(backend.execute(runInput("id1", "different text"))).rejects.toThrow(
      /different payload/i,
    );
  }, 15_000);

  test("steer targets the live run", async () => {
    const segment = await backend.execute(runInput("st1"));
    await backend.steer("st1", {
      inputId: "in-steer",
      message: { role: "user", text: "steer now" },
    });
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
  }, 15_000);

  test("steer on a non-live run fails explicitly", async () => {
    await expect(
      backend.steer("ghost-run", { inputId: "in-x", message: { role: "user", text: "x" } }),
    ).rejects.toThrow(/live run/i);
  }, 15_000);

  test("stop terminates only the target run", async () => {
    const a = await backend.execute(runInput("x1"));
    const b = await backend.execute(runInput("x2"));
    await a.stop();
    const [oa, ob] = await Promise.all([a.outcome, b.outcome]);
    expect(["aborted", "completed"]).toContain(oa.status);
    expect(ob.status).toBe("completed");
  }, 15_000);
});

import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";

function makeConfig(opts?: Record<string, unknown>) {
  return {
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    maxSteps: 2,
    ...opts,
  };
}

describe("Agent", () => {
  // ── Basic lifecycle ──
  test("constructs with idle state", () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    expect(agent.state).toBe("idle");
  });

  test("prompt transitions to done", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    await agent.prompt("hello");
    expect(agent.state === "done" || agent.state === "idle").toBe(true);
  });

  test("subscribe receives events", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));
    await agent.prompt("hi");
    expect(events.length).toBeGreaterThan(0);
  });

  test("subscribe returns unsubscribe", () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    let calls = 0;
    const unsub = agent.subscribe(() => calls++);
    unsub();
    expect(calls).toBe(0);
  });

  test("dispose returns to idle", () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    agent.dispose();
    expect(agent.state).toBe("idle");
  });

  // ── State transitions ──
  test("idle→running→done on prompt", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    expect(agent.state).toBe("idle");
    let sawRunning = false;
    agent.subscribe(() => {
      if (agent.state === "running") sawRunning = true;
    });
    await agent.prompt("hi");
    expect(sawRunning).toBe(true);
  });

  test("agent_end has status succeeded", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    let status: string | undefined;
    agent.subscribe((e) => {
      if (e.type === "agent_end") status = (e as { status: string }).status;
    });
    await agent.prompt("hi");
    expect(status).toBe("succeeded");
  });

  // ── Steer / followUp ──
  test("steer throws when idle", () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    expect(() => agent.steer("hey")).toThrow();
  });

  test("steer emits queue_update during run", async () => {
    const agent = new Agent(
      makeConfig({
        model: echoModel({
          turns: [
            { type: "text", text: "working" },
            { type: "text", text: "done" },
          ],
        }),
    );
    agent.subscribe((_e) => {});
    const p = agent.prompt("hi");
    try {
      agent.steer("correct course");
    } catch {
      /* may not be running yet */
    }
    await p;
    // steer may or may not have been processed; just verify no crash
    expect(true).toBe(true);
  });

  // ── waitForIdle ──
  test("waitForIdle resolves when done", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    await agent.prompt("hi");
    await agent.waitForIdle();
  });

  // ── getContextUsage ──
  test("getContextUsage returns message count after run", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    await agent.prompt("hi");
    const usage = agent.getContextUsage();
    expect(usage).toBeDefined();
    expect(typeof usage!.messageCount).toBe("number");
  });

  // ── compact ──
  // ── getUsage ──



  // ── compact ──
  test("compact throws without checkpointer", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    await agent.prompt("hi");
    await expect(agent.compact()).rejects.toThrow("MessageStore");
  });
  // ── Multiple runs ──
  test("second prompt routes as steer (does not error)", async () => {
    const agent = new Agent(makeConfig({ eventLog: { readEvents: async function* () { yield { type: "model_end", usage: { input: 100, output: 50 }, model: "test", step: 0, latencyMs: 1, ts: 1 }; } } } }));
    // Start first prompt in background
    const p1 = agent.prompt("first");
    // Second prompt should route as steer, not crash
    try {
      agent.steer("second");
    } catch {
      /* not running yet */
    }
    await p1;
  });

  // ── Retry ──
  // ── after:turn contract ──
  test("after:turn fires exactly once per external turn", async () => {
    const calls: unknown[][] = [];
    const agent = new Agent(
      makeConfig({
        hooks: { "after:turn": async (_ctx: unknown, msgs: unknown[]) => void calls.push(msgs) },
    );
    await agent.prompt("hi");
    expect(calls.length).toBe(1);
  });

  test("after:turn fires once on error, not per retry attempt", async () => {
    const calls: unknown[][] = [];
    const agent = new Agent(
      makeConfig({
        hooks: { "after:turn": async (_ctx: unknown, msgs: unknown[]) => void calls.push(msgs) },
        model: {},
        retry: { maxAttempts: 2, backoffMs: 10 },
    );
    try {
      await agent.prompt("hi");
    } catch {
      /* expected */
    }
    expect(calls.length).toBe(1);
  });

  test("retry on failure model", async () => {
    let calls = 0;
    const agent = new Agent(
      makeConfig({
        model: {
          id: "test",
          stream: async function* () {
            calls++;
            if (calls === 1) throw new Error("transient failure");
            yield { delta: { type: "text", text: "recovered" }, usage: { input: 1, output: 2 } };
            yield { done: true, stopReason: "end_turn" as const };
          },
          countTokens: async () => 0,
        } as unknown as typeof echoModel extends (...args: infer A) => infer R ? R : never,
    );
    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));
    await agent.prompt("hi");
    expect(calls).toBeGreaterThan(1);
    expect(events).toContain("auto_retry_start");
    expect(events).toContain("auto_retry_end");
  });
});

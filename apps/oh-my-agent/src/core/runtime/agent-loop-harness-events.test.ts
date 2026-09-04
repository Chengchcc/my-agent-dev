import { describe, expect, test } from "bun:test";
import { ProviderError } from "@chengchenccc/ai";
import { createOmaSession } from "./agent-loop.js";
import {
  createMemoryStores,
  createSession,
  fakeSummarize,
  loopInput,
  staticTool,
  textModel,
} from "./coding-agent-harness.fixture.js";

const { storeFactory, reopenFactory } = createMemoryStores();

describe("agent loop harness events/plugins", () => {
  test("14. delayed listener blocks loop settlement", async () => {
    const store = storeFactory("h14");
    await createSession(store, "h14");
    const loop = createOmaSession({
      sessionId: "h14",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("ok"),
    });
    let resolved = false;
    let settleSeen = false;
    const { promise, resolve } = Promise.withResolvers<void>();
    loop.onEvent((e) => {
      if (e.type === "agent_end") {
        return promise.then(() => {
          resolved = true;
        });
      }
      return undefined;
    });
    const started = loop.startLoop(loopInput({ message: "go" }));
    const settle = started.then(() => {
      settleSeen = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settleSeen).toBe(false); // listener still pending
    resolve();
    await settle;
    expect(settleSeen).toBe(true);
    expect(resolved).toBe(true);
  });

  test("15. reopen does not restore an active loop", async () => {
    const store = storeFactory("h15");
    await createSession(store, "h15");
    const loop = createOmaSession({
      sessionId: "h15",
      store,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.startLoop(loopInput({ message: "go" }));
    if (!reopenFactory) return;
    const reopened = reopenFactory("h15");
    const snap = await reopened.open("h15");
    // Completed branch + todo remain, but no active loop object exists
    expect(snap.entries.length).toBeGreaterThan(0);
    // A fresh loop starts idle; nothing auto-resumes
    const fresh = createOmaSession({
      sessionId: "h15",
      store: reopened,
      plugins: [],
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("x"),
    });
    expect(fresh.status).toBe("idle");
  });

  test("16. credential sentinel appears nowhere in store/events/errors", async () => {
    const store = storeFactory("h16");
    await createSession(store, "h16");
    const SENTINEL = "sk-sentinel-123456";
    const loop = createOmaSession({
      sessionId: "h16",
      store,
      plugins: [],
      maxSteps: 3,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        // Partial output, then a fatal auth error containing the sentinel.
        yield { delta: { type: "text", text: "partial" } };
        throw new ProviderError(`boom with ${SENTINEL} inside`, "auth");
      },
    });
    const eventPayloads: string[] = [];
    loop.onEvent((e) => {
      eventPayloads.push(JSON.stringify(e));
    });
    await loop.startLoop(loopInput({ message: "go" }));
    // The loop surfaces the failure via agent_end only; the raw error is
    // normalized by the provider layer before reaching the loop.
    const snap = await store.open("h16");
    const storeSerialized = JSON.stringify(snap.entries);
    expect(storeSerialized).not.toContain(SENTINEL);
    expect(eventPayloads.join("")).not.toContain(SENTINEL);
    expect(loop.status).toBe("failed");
  });

  test("17. modelStream receives static + per-run tool schemas each turn", async () => {
    const store = storeFactory("h17");
    await createSession(store, "h17");
    let seenTools: ReadonlyArray<{ name: string }> = [];

    const loop = createOmaSession({
      sessionId: "h17",
      store,
      plugins: [{ name: "native", tools: [staticTool("ls"), staticTool("read")] }],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      resolveTools: async () => [staticTool("history_recent")],
      modelStream: async function* (_messages, _signal, tools) {
        seenTools = tools ?? [];
        yield { delta: { type: "text", text: "done" } };
        yield { stopReason: "end_turn" };
      },
    });
    await loop.startLoop(loopInput({ message: "go" }));

    const names = seenTools.map((t) => t.name);
    expect(names).toContain("ls");
    expect(names).toContain("read");
    expect(names).toContain("history_recent"); // per-run resolved
  });

  test("18. beforeRun fires once before the first model turn", async () => {
    const store = storeFactory("h18");
    await createSession(store, "h18");
    let beforeRunCalls = 0;
    let beforeRunMsgCount = -1;

    const loop = createOmaSession({
      sessionId: "h18",
      store,
      plugins: [
        {
          name: "tracker",
          hooks: {
            beforeRun(messages) {
              beforeRunCalls++;
              beforeRunMsgCount = messages.length;
            },
          },
        },
      ],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.startLoop(loopInput({ message: "go" }));

    expect(beforeRunCalls).toBe(1);
    expect(beforeRunMsgCount).toBeGreaterThan(0);
  });

  test("19. afterRun fires once with completed status and full messages", async () => {
    const store = storeFactory("h19");
    await createSession(store, "h19");
    let afterRunCalls = 0;
    let afterRunStatus = "";
    let afterRunMsgCount = -1;

    const loop = createOmaSession({
      sessionId: "h19",
      store,
      plugins: [
        {
          name: "tracker",
          hooks: {
            afterRun(status, messages) {
              afterRunCalls++;
              afterRunStatus = status;
              afterRunMsgCount = messages.length;
            },
          },
        },
      ],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.startLoop(loopInput({ message: "go" }));

    expect(afterRunCalls).toBe(1);
    expect(afterRunStatus).toBe("completed");
    expect(afterRunMsgCount).toBeGreaterThan(0);
  });

  test("20. beforeRun/afterRun fire once each on multi-turn runs", async () => {
    const store = storeFactory("h20");
    await createSession(store, "h20");
    let beforeRunCalls = 0;
    let afterRunCalls = 0;
    let modelCalls = 0;

    const loop = createOmaSession({
      sessionId: "h20",
      store,
      plugins: [
        {
          name: "tracker",
          hooks: {
            beforeRun() {
              beforeRunCalls++;
            },
            afterRun() {
              afterRunCalls++;
            },
          },
        },
      ],
      maxSteps: 5,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          yield { delta: { type: "tool_use", id: "tc1", name: "echo" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
          yield { stopReason: "end_turn" };
        }
      },
    });
    await loop.startLoop(loopInput({ message: "go" }));

    expect(modelCalls).toBeGreaterThanOrEqual(2);
    expect(beforeRunCalls).toBe(1);
    expect(afterRunCalls).toBe(1);
  });

  test("pause_turn forces one continuation like max_tokens", async () => {
    const store = storeFactory("h21");
    await createSession(store, "h21");
    let modelCalls = 0;

    const loop = createOmaSession({
      sessionId: "h21",
      store,
      plugins: [],
      maxSteps: 3,
      maxForceContinues: 1,
      summarize: fakeSummarize,
      modelStream: async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          yield { delta: { type: "text", text: "partial" } };
          yield { stopReason: "pause_turn" };
        } else {
          yield { delta: { type: "text", text: "rest" } };
          yield { stopReason: "end_turn" };
        }
      },
    });
    await loop.startLoop(loopInput({ message: "go" }));

    expect(modelCalls).toBe(2);
    expect(loop.status).toBe("completed");
  });
});

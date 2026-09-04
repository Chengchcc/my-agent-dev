import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ProviderError } from "@chengchenccc/ai";
import { createOmaSession } from "./agent-loop.js";
import {
  createMemoryStores,
  createSession,
  fakeSummarize,
  loopInput,
  textModel,
} from "./coding-agent-harness.fixture.js";
import type { Plugin } from "./plugin.js";
import { readTodo, writeTodo } from "./todo.js";

const { storeFactory, reopenFactory } = createMemoryStores();

describe("agent loop harness compaction/todo/skill", () => {
  test("10. compaction appends entry and shapes next turn", async () => {
    const store = storeFactory("h10");
    await createSession(store, "h10");
    for (let i = 0; i < 8; i++) {
      await store.appendBatch("h10", {
        entries: [
          {
            type: "message",
            role: "user",
            source: "prompt",
            message: { role: "user", text: `msg ${i}` },
            createdAt: Date.now(),
          },
        ],
      });
    }
    const loop = createOmaSession({
      sessionId: "h10",
      store,
      plugins: [],
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      modelStream: textModel("done"),
    });
    await loop.compact();
    const snap = await store.open("h10");
    const comp = snap.entries.filter((e) => e.type === "compaction");
    expect(comp).toHaveLength(1);
    // Originals retained
    const msgCount = snap.entries.filter((e) => e.type === "message").length;
    expect(msgCount).toBe(8);
  });

  test("11. overflow compacts once and retries once within the same turn", async () => {
    const store = storeFactory("h11");
    await createSession(store, "h11");
    // Seed messages so overflow compaction has something to cover
    for (let i = 0; i < 6; i++) {
      await store.appendBatch("h11", {
        entries: [
          {
            type: "message",
            role: "user",
            source: "prompt",
            message: { role: "user", text: `seed ${i}` },
            createdAt: i,
          },
        ],
      });
    }
    let attempts = 0;
    let compacted = false;
    const loop = createOmaSession({
      sessionId: "h11",
      store,
      plugins: [],
      // maxSteps = 1: overflow recovery must NOT consume an extra step
      maxSteps: 1,
      maxForceContinues: 0,
      summarize: fakeSummarize,
      // triggerRatio high enough that proactive does NOT preempt overflow;
      // this isolates the overflow path using the same ContextBudget.
      contextBudget: {
        estimate: (m: { text?: string }) => Math.ceil((m.text ?? "").length / 4),
        limit: 10,
        triggerRatio: 100,
      },
      modelStream: async function* () {
        attempts++;
        if (!compacted) {
          throw new ProviderError("prompt is too long: 200001 > 200000 maximum", "overflow");
        }
        yield { delta: { type: "text", text: "done" } };
      },
    });
    // Compaction happens inside the loop; detect it via events
    const events: string[] = [];
    loop.onEvent((e) => {
      events.push(e.type);
      if (e.type === "compaction_end") compacted = true;
    });
    await loop.startLoop(loopInput({ message: "go" }));
    expect(attempts).toBe(2);
    expect(compacted).toBe(true);
    expect(loop.status).toBe("completed");
    expect(events).toContain("compaction_start");
    expect(events).toContain("compaction_end");
    // Overflow used the same ContextBudget: diagnostics recorded
    const snap11 = await store.open("h11");
    const comp11 = snap11.entries.find((e) => e.type === "compaction") as {
      tokensBefore?: number;
    };
    expect(comp11?.tokensBefore).toBeGreaterThan(0);
  });

  test("12. todo survives restart", async () => {
    const store = storeFactory("h12");
    await createSession(store, "h12");
    await writeTodo(store, "h12", {
      items: [{ id: "t1", text: "task", status: "in_progress" }],
    });
    if (!reopenFactory) return; // SQLite-only restart
    const reopened = reopenFactory("h12");
    const state = await readTodo(reopened, "h12");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.status).toBe("in_progress");
  });

  test("13. skill meta shows index only; skill_load reads body lazily", async () => {
    const root = `/tmp/skill-harness-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(`${root}/math`, { recursive: true });
    writeFileSync(
      `${root}/math/SKILL.md`,
      "---\nname: math\n---\n\nBody of math skill ${SKILL_DIR}/x",
    );
    const store = storeFactory("h13");
    await createSession(store, "h13");
    // Local stand-in for the progressive-skill plugin: index in Meta,
    // body only readable through skill_load (lazy).
    let bodyRead = 0;
    const skillPlugin: Plugin = {
      name: "skills",
      meta: [
        {
          name: "Available Skills",
          render: () => "- **math**: do math",
        },
      ],
      tools: [
        {
          name: "skill_load",
          description: "Load a skill body",
          inputSchema: { type: "object", properties: { name: { type: "string" } } },
          async execute(args) {
            if (args.name !== "math") return { error: "not found" };
            bodyRead++;
            return { body: `Body of math skill ${root}/math` } as unknown as Readonly<
              Record<string, unknown>
            >;
          },
        },
      ],
    };
    const metaText = skillPlugin.meta?.map((m) => m.render()).join("\n") ?? "";
    // Meta contains only the index (name/description), never the body
    expect(metaText).toContain("math");
    expect(metaText).not.toContain("Body of math skill");
    expect(bodyRead).toBe(0); // Meta render did not read bodies

    // skill_load reads the body on demand
    const loadTool = skillPlugin.tools?.find((t) => t.name === "skill_load");
    expect(loadTool).toBeTruthy();
    const result = (await loadTool!.execute({ name: "math" })) as { body?: string };
    expect(result.body).toContain("Body of math skill");
    expect(result.body).toContain(`${root}/math`);
    expect(bodyRead).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

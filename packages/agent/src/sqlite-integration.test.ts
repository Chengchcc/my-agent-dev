import { describe, expect, test } from "bun:test";
import { Session } from "./persistence/session.js";
import { sqliteCheckpointer } from "./persistence/sqlite-checkpointer.js";
import { sqliteSessionStorage } from "./persistence/sqlite-session-storage.js";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";

function tmpDb(): string {
  return `/tmp/agent-test-${crypto.randomUUID()}.sqlite`;
}

function makeAgent(cfg: Partial<AgentConfig> & { sessionId: string; db: string }): Agent {
  return new Agent({
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    maxSteps: 2,

    checkpointer: sqliteCheckpointer({ db: cfg.db }),
    session: new Session(sqliteSessionStorage({ db: cfg.db, sessionId: cfg.sessionId })),
    ...cfg,
  });
}

describe("SQLite compact persistence", () => {
  test("compact persists and reloads from checkpointer", async () => {
    const db = tmpDb();
    const sessionId = "test-compact-reload";
    const a1 = makeAgent({ sessionId, db });
    await a1.prompt("long conversation about state");
    // compact saves to checkpointer + session storage
    await a1.compact();
    a1.dispose();

    const a2 = makeAgent({ sessionId, db });
    // trigger init to load checkpointer state
    await a2.continue();
    const count = a2.getContextUsage()?.messageCount ?? 0;
    expect(count).toBeGreaterThan(0);
    a2.dispose();
  });

  test("compact then continue works after reload", async () => {
    const db = tmpDb();
    const sessionId = "test-compact-continue";
    const a1 = makeAgent({ sessionId, db });
    await a1.prompt("hello");
    await a1.compact();
    a1.dispose();

    const a2 = makeAgent({ sessionId, db });
    // continue should work on reloaded session
    await a2.continue();
    expect(a2.getContextUsage()?.messageCount ?? 0).toBeGreaterThan(0);
    a2.dispose();
  });
});

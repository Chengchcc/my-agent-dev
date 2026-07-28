import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";
import { Session } from "./persistence/session.js";
import { sqlitePersistence } from "./persistence/sqlite-persistence.js";
import { sqliteSessionStorage } from "./persistence/sqlite-session-storage.js";

function tmpDb(): string {
  return `/tmp/agent-test-${crypto.randomUUID()}.sqlite`;
}

function makeAgent(cfg: Partial<AgentConfig> & { sessionId: string; db: string }): Agent {
  const stores = sqlitePersistence({ db: cfg.db });
  return new Agent({
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    maxSteps: 2,
    messageStore: stores.messageStore,
    eventLog: stores.eventLog,
    interruptStore: stores.interruptStore,
    session: new Session(sqliteSessionStorage({ db: cfg.db, sessionId: cfg.sessionId })),
    ...cfg,
  });
}

describe("SQLite compact persistence", () => {
  test("compact persists and reloads from messageStore", async () => {
    const db = tmpDb();
    const sessionId = "test-compact-reload";
    const a1 = makeAgent({ sessionId, db });
    await a1.prompt("long conversation about state");
    // compact saves to messageStore + session storage
    await a1.compact();
    a1.dispose();

    const a2 = makeAgent({ sessionId, db });
    // trigger init to load persisted state
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

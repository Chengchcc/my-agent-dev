import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { agentRunRoutes } from "./http.js";

const db = openDb(":memory:");
const app = agentRunRoutes({
  db,
  agentRunService: {} as never,
  agentRunExecution: {} as never,
});

function seedDefaultMember(conversationId: string, now: number): void {
  db.query(
    "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES (?, 'mention', 0, ?)",
  ).run(conversationId, now);
  db.query(
    "INSERT INTO member (member_id, conversation_id, kind, agent_id, display_name, joined_at) VALUES ('default', ?, 'agent', 'ag-1', 'Assistant', ?)",
  ).run(conversationId, now);
  db.query(
    "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES (?, ?, 'default', ?)",
  ).run(`tree-${conversationId}`, conversationId, now);
  db.query(
    "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES (?, ?, 0, 'anthropic', 1, 1, ?)",
  ).run(`br-${conversationId}`, `tree-${conversationId}`, now);
}

function seedRun(runId: string, conversationId: string, now: number): void {
  db.query(
    `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at)
     VALUES (?, ?, ?, 'default', '{"backendKind":"coding_agent","modelId":"fake/echo"}', 'completed', ?, 1, ?)`,
  ).run(runId, `br-${conversationId}`, conversationId, `ik-${runId}`, now);
}

describe("agent run list", () => {
  test("a run appears once even when memberId exists in multiple conversations", async () => {
    const now = Date.now();
    for (const cid of ["c-multi-1", "c-multi-2", "c-multi-3"]) {
      seedDefaultMember(cid, now);
    }
    seedRun("run-uniq", "c-multi-1", now);

    const resp = await app.handle(new Request("http://localhost/api/agent-runs?limit=50"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { runs: Array<{ runId: string }> };
    const hits = body.runs.filter((r) => r.runId === "run-uniq");
    expect(hits).toHaveLength(1);
  });

  test("agentId filter resolves through the conversation-scoped member join", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/agent-runs?limit=50&agentId=ag-1"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { runs: Array<{ runId: string; agentId: string | null }> };
    expect(body.runs.length).toBeGreaterThan(0);
    for (const r of body.runs) expect(r.agentId).toBe("ag-1");
  });
});

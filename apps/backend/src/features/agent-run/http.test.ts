import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { agentRunRoutes } from "./http.js";

const db = openDb(":memory:");
const app = agentRunRoutes({
  db,
  agentRunService: {} as never,
  agentRunExecution: {} as never,
  modelCosts: Promise.resolve(new Map()),
});

function seedConversation(conversationId: string, now: number): void {
  db.query(
    "INSERT INTO conversation (conversation_id, agent_id, trigger_mode, hop_count, created_at) VALUES (?, 'ag-1', 'mention', 0, ?)",
  ).run(conversationId, now);
  db.query(
    "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES (?, ?, ?)",
  ).run(`tree-${conversationId}`, conversationId, now);
  db.query(
    "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES (?, ?, 0, 'anthropic', 1, 1, ?)",
  ).run(`br-${conversationId}`, `tree-${conversationId}`, now);
}

function seedRun(runId: string, conversationId: string, now: number): void {
  db.query(
    `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
     VALUES (?, ?, ?, 'ag-1', '{"backendKind":"oma","modelId":"fake/echo"}', 'completed', ?, 1, ?)`,
  ).run(runId, `br-${conversationId}`, conversationId, `ik-${runId}`, now);
}

describe("agent run list", () => {
  test("a run appears once in the run list", async () => {
    const now = Date.now();
    seedConversation("c-multi-1", now);
    seedRun("run-uniq", "c-multi-1", now);

    const resp = await app.handle(new Request("http://localhost/api/agent-runs?limit=50"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { runs: Array<{ runId: string }> };
    const hits = body.runs.filter((r) => r.runId === "run-uniq");
    expect(hits).toHaveLength(1);
  });

  test("verdict derives from tool_result.is_error, not the model text", async () => {
    const now = Date.now();
    seedConversation("c-verdict", now);
    seedRun("run-verdict", "c-verdict", now);
    db.query("UPDATE agent_run SET terminal_result = ? WHERE run_id = ?").run(
      JSON.stringify({
        status: "completed",
        messages: [
          {
            role: "tool",
            blocks: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
          },
        ],
      }),
      "run-verdict",
    );
    const resp = await app.handle(
      new Request("http://localhost/api/agent-runs?limit=50&agentId=ag-1"),
    );
    const body = (await resp.json()) as {
      runs: Array<{ runId: string; verdict: string }>;
    };
    expect(body.runs.find((r) => r.runId === "run-verdict")?.verdict).toBe("fail");
  });
});

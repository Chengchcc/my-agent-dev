// Dev-only demo seed: inserts realistic fake rows (agent runs across the
// last 24h, workflow executions incl. resolvable human gates, artifact files
// with provenance) so the redesigned web UI renders at full density.
// Run from apps/backend: bun scripts/seed-demo.ts
// Idempotent-ish: new unique ids each run; safe to re-run on the dev DB.
import { Database } from "bun:sqlite";

const db = new Database(".backend-data/backend.db");
const now = Date.now();
const H = 3600_000;
const rid = () =>
  Array.from({ length: 24 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

// ── agent_run: clone the latest real row, spread across last 24h ──
const sample = db
  .query(
    "SELECT * FROM agent_run WHERE terminal_result IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
  .get() as Record<string, unknown>;
const models = [
  '{"backendKind":"oma","modelId":"deepseek/deepseek-v4-flash"}',
  '{"backendKind":"oma","modelId":"anthropic/claude-sonnet-5"}',
  '{"backendKind":"oma","modelId":"openai/gpt-5.4"}',
  '{"backendKind":"oma","modelId":"zai/glm-5.3"}',
];
const insertRun = db.query(
  `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, terminal_result, config_revision, created_at, terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
);
let seeded = 0;
// active statuses need a unique branch each (partial unique index)
const newBranch =
  db.prepare(`INSERT INTO agent_context_branch (branch_id, tree_id, leaf_entry_id, ledger_cursor, backend_kind, is_default, revision, created_at, cli_session_ref)
  SELECT ?, tree_id, leaf_entry_id, ledger_cursor, backend_kind, 0, revision, ?, cli_session_ref FROM agent_context_branch WHERE branch_id = ?`);
for (let i = 0; i < 48; i++) {
  const hoursAgo = Math.random() * 24;
  const createdAt = Math.round(now - hoursAgo * H);
  const roll = Math.random();
  const status =
    roll < 0.78 ? "completed" : roll < 0.86 ? "failed" : roll < 0.94 ? "running" : "waiting";
  const modelRef = models[i % models.length];
  const inTok = 800 + Math.floor(Math.random() * 12000);
  const outTok = 200 + Math.floor(Math.random() * 4000);
  const cost = +(inTok * 3e-6 + outTok * 15e-6 + Math.random() * 0.3).toFixed(4);
  const terminalAt =
    status === "running" || status === "waiting"
      ? null
      : createdAt + 20_000 + Math.floor(Math.random() * 400_000);
  const terminalResult = JSON.stringify({
    status: status === "completed" ? "completed" : status === "failed" ? "failed" : status,
    usage: { inputTokens: inTok, outputTokens: outTok, costUsd: cost },
  });
  let branchId = String(sample.branch_id);
  if (status === "running" || status === "waiting") {
    branchId = rid();
    newBranch.run(branchId, branchId, createdAt);
  }
  insertRun.run(
    rid(),
    branchId,
    sample.conversation_id,
    sample.agent_id,
    modelRef,
    status,
    `seed-${rid()}`,
    terminalResult,
    Number(sample.config_revision ?? 1),
    createdAt,
    terminalAt,
  );
  seeded++;
}

// ── workflow executions today: gates + success + failed + running ──
const wfSample = db
  .query(
    "SELECT * FROM workflow_execution WHERE status = 'waiting_human' ORDER BY created_at DESC LIMIT 1",
  )
  .get() as Record<string, unknown> | undefined;
let execSeeded = 0;
if (wfSample) {
  const insExec = db.query(
    `INSERT INTO workflow_execution (execution_id, workflow_id, triggered_by, definition, input, store, status, exit, error, created_at, terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insNode = db.query(
    `INSERT INTO workflow_node_run (execution_id, node_id, run_id, status, "order", output, routed_to, error, created_at, terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const wfId: string = String(wfSample.workflow_id);
  void wfId; // eslint-disable-line @typescript-eslint/no-unused-vars -- documents the source pack
  const definition = String(wfSample.definition);
  const plans = [
    {
      id: rid(),
      wf: "nighttime-report",
      trig: "cron:0 3 * * *",
      status: "waiting_human",
      hoursAgo: 2.1,
    },
    { id: rid(), wf: "self-heal", trig: "manual", status: "waiting_human", hoursAgo: 5.4 },
    { id: rid(), wf: "nighttime-report", trig: "cron:0 3 * * *", status: "success", hoursAgo: 7.2 },
    { id: rid(), wf: "self-heal", trig: "manual", status: "failure", hoursAgo: 9.8 },
    {
      id: rid(),
      wf: "nighttime-report",
      trig: "cron:0 3 * * *",
      status: "success",
      hoursAgo: 14.5,
    },
    { id: rid(), wf: "self-heal", trig: "manual", status: "running", hoursAgo: 0.6 },
    {
      id: rid(),
      wf: "nighttime-report",
      trig: "cron:0 3 * * *",
      status: "success",
      hoursAgo: 20.1,
    },
  ];
  for (const plan of plans) {
    const createdAt = Math.round(now - plan.hoursAgo * H);
    const terminalAt = ["success", "failure"].includes(plan.status) ? createdAt + 90_000 : null;
    insExec.run(
      plan.id,
      plan.wf,
      plan.trig,
      definition,
      "{}",
      "{}",
      plan.status,
      plan.status === "failure" ? "script exited 1" : null,
      null,
      createdAt,
      terminalAt,
    );
    execSeeded++;
    if (plan.status === "waiting_human") {
      insNode.run(plan.id, "review", null, "waiting_human", 2, null, null, null, createdAt, null);
      insNode.run(
        plan.id,
        "scan",
        `seedrun-${rid()}`,
        "completed",
        1,
        '{"ok":true}',
        null,
        null,
        createdAt - 60_000,
        createdAt - 30_000,
      );
    }
  }
}

// ── artifacts: files + meta.json with provenance ──
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = ".backend-data/artifacts";
const arts = [
  {
    folder: "report/2026-09",
    filename: "nightly-summary.md",
    body: "# Nightly summary\n\nAll checks passed.\n",
    source: { runId: rid(), agentId: "default" },
  },
  {
    folder: "report/2026-09",
    filename: "gate-diff.sql",
    body: "-- proposed migration\nALTER TABLE runs ADD COLUMN note TEXT;\n",
    source: { runId: rid(), agentId: "default" },
  },
  {
    folder: "report/2026-09",
    filename: "coverage.json",
    body: '{"total":0.94}\n',
    source: { runId: rid(), agentId: "default" },
  },
  {
    folder: "scan",
    filename: "repo-inventory.md",
    body: "# Inventory\n\n- 34 packages\n",
    source: { runId: rid(), agentId: "default" },
  },
  {
    folder: "scan",
    filename: "schema-dump.sql",
    body: "SELECT 1;\n",
    source: { conversationId: "seed", agentId: "default" },
  },
  {
    folder: "ops",
    filename: "wal-checkpoint.txt",
    body: "checkpoint ok\n",
    source: { agentId: "default" },
  },
];
for (const a of arts) {
  const dir = join(root, a.folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, a.filename), a.body);
  writeFileSync(
    join(dir, `${a.filename}.meta.json`),
    JSON.stringify({
      encoding: "utf8",
      source: a.source,
      updatedAt: now - Math.floor(Math.random() * 20 * H),
    }),
  );
}

console.log(`seeded: ${seeded} runs, ${execSeeded} executions, ${arts.length} artifacts`);

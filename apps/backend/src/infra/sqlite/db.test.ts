import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { openDb } from "./db.js";

// ─── Test 1: openDb creates file and runs drizzle-kit migrations ───

test("openDb creates database file and runs drizzle-kit migrations", () => {
  const tmpPath = `/tmp/test-backend-db-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  // Verify tables exist (backend own, 9 domain tables)
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("agents");
  expect(names).not.toContain("threads");
  // Phase 6: legacy execution audit tables are gone — Agent Run is the only
  // execution identity (agent_run + product_tool_call hold the facts).
  expect(names).not.toContain("span");
  expect(names).not.toContain("attempt");
  expect(names).not.toContain("control_plane_event");
  expect(names).not.toContain("span_origin");
  // S2: projection_messages deleted (redundant third copy of messages)
  expect(names).not.toContain("projection_messages");
  // M20: checkpoint_* tables are in checkpointer.sqlite, NOT backend.db
  expect(names).not.toContain("checkpoint_messages");
  expect(names).not.toContain("checkpoint_interrupts");
  expect(names).not.toContain("checkpoint_events");
  // drizzle-kit migration ledger (replaces old _migrations)
  expect(names).toContain("__drizzle_migrations");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 2: migrations are idempotent ──────────────────────────

test("migrations are idempotent (calling openDb twice is safe)", () => {
  const tmpPath = `/tmp/test-backend-db-idem-${Math.random().toString(36).slice(2, 8)}.db`;

  const db1 = openDb(tmpPath);
  const tables1 = (
    db1.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  db1.close();

  // Second open should not error
  const db2 = openDb(tmpPath);
  const tables2 = (
    db2.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  db2.close();

  expect(tables2).toEqual(tables1);

  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 3: drizzle migration ledger is populated ──────────────

test("__drizzle_migrations table tracks applied migrations", () => {
  const tmpPath = `/tmp/test-backend-db-ver-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const rows = db.query("SELECT hash FROM __drizzle_migrations").all() as {
    hash: string;
  }[];
  expect(rows.length).toBeGreaterThan(0);

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 4: WAL mode is enabled ────────────────────────────────

test("WAL journal mode is enabled", () => {
  const tmpPath = `/tmp/test-backend-db-wal-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 4b: foreign_keys and busy_timeout are enabled ────────

test("foreign_keys and busy_timeout pragmas are enabled", () => {
  const tmpPath = `/tmp/test-backend-db-pragmas-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(fk.foreign_keys).toBe(1);
  const bt = db.query("PRAGMA busy_timeout").get() as { timeout: number };
  expect(bt.timeout).toBe(5000);

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 5: M10 conversation tables exist ─────────────────────

test("M10 conversation/conversation_ledger tables exist after migration", () => {
  const tmpPath = `/tmp/test-backend-db-m10-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("conversation");
  // 0037 (1:1 collapse): the member table is dropped, agent binding lives
  // on conversation.agent_id.
  expect(names).not.toContain("member");
  const convCols = db.query("PRAGMA table_info('conversation')").all() as { name: string }[];
  expect(convCols.map((c) => c.name)).toContain("agent_id");

  // Verify conversation_ledger shape
  const ledgerCols = db.query("PRAGMA table_info('conversation_ledger')").all() as {
    name: string;
  }[];
  expect(ledgerCols.map((c) => c.name)).toContain("seq");
  expect(ledgerCols.map((c) => c.name)).toContain("sender_member_id");
  expect(ledgerCols.map((c) => c.name)).toContain("kind");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Phase 1: migration and constraint tests ───────────────────

const PHASE1_TABLES = [
  "agent_context_tree",
  "agent_context_entry",
  "agent_context_branch",
  "agent_run",
  "branch_input_queue",
  "pending_action",
] as const;

test("Phase 1: fresh migration creates six tables and active-branch index, drops session_id and the session binding", () => {
  const tmpPath = `/tmp/test-backend-db-p1-fresh-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);

  for (const t of PHASE1_TABLES) {
    expect(names).toContain(t);
  }

  // checkpoint tables must not exist in backend.db
  expect(names).not.toContain("checkpoint_messages");
  expect(names).not.toContain("checkpoint_interrupts");
  expect(names).not.toContain("checkpoint_events");

  // The Backend Session Binding table is gone (no cross-Run sessions).
  expect(names).not.toContain("backend_session_binding");

  // 0037: the member table itself is gone (agent binding on conversation).
  expect(names).not.toContain("member");

  // active-branch partial unique index exists
  const idx = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_run_active_branch'",
    )
    .all();
  expect(idx).toHaveLength(1);

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

/** Helper: build a pre-0012 fixture (conversation + agent member with legacy
 *  session_id + one ledger row) by applying migrations 0000-0011 only, then
 *  apply 0012 and verify product facts survive. */
function buildPreMigrationFixture(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // bun test runs from both the repo root and the package dir; probe both.
  const migrationsDir =
    ["drizzle/backend", "apps/backend/drizzle/backend"].find((p) => existsSync(p)) ??
    "drizzle/backend";
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && f < "0012_")
    .sort();
  for (const f of files) {
    const sql = readFileSync(`${migrationsDir}/${f}`, "utf8");
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter((s) => s);
    for (const s of stmts) {
      try {
        db.exec(s);
      } catch {
        /* may already exist */
      }
    }
  }
  // Insert legacy fixture: conversation, agent member with session_id, ledger row
  db.exec(
    "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES ('c-fix', 'mention', 0, 1000)",
  );
  db.exec(
    "INSERT INTO member (member_id, conversation_id, kind, agent_id, display_name, session_id, joined_at) VALUES ('m-fix', 'c-fix', 'agent', 'ag-fix', 'FixAgent', 'legacy-session-xyz', 1000)",
  );
  db.exec(
    "INSERT INTO conversation_ledger (seq, conversation_id, sender_member_id, addressed_to, kind, content, ts) VALUES (1, 'c-fix', 'm-fix', '[]', 'message', '{\"text\":\"hello\"}', 1000)",
  );
  db.close();
}

test("Phase 1: existing product facts survive 0012 migration, no Context backfilled", () => {
  const tmpPath = `/tmp/test-backend-db-p1-upgrade-${Math.random().toString(36).slice(2, 8)}.db`;
  buildPreMigrationFixture(tmpPath);

  // Apply 0012 migration manually on the pre-migration fixture (drizzle migrator
  // tracks its own ledger, so we apply the raw SQL like a real upgrade would).
  const db = new Database(tmpPath);
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsDir2 =
    ["drizzle/backend", "apps/backend/drizzle/backend"].find((p) => existsSync(p)) ??
    "drizzle/backend";
  const sql0012 = readFileSync(`${migrationsDir2}/0012_agent_context_and_runs.sql`, "utf8");
  for (const s of sql0012
    .split("--> statement-breakpoint")
    .map((s: string) => s.replace(/^--.*$/gm, "").trim())
    .filter((s: string) => s)) {
    db.exec(s);
  }

  // Product facts survive
  const conv = db.query("SELECT * FROM conversation WHERE conversation_id='c-fix'").get() as {
    conversation_id: string;
  };
  expect(conv.conversation_id).toBe("c-fix");

  const mem = db.query("SELECT * FROM member WHERE member_id='m-fix'").get() as {
    member_id: string;
    kind: string;
  };
  expect(mem.member_id).toBe("m-fix");
  expect(mem.kind).toBe("agent");

  const ledger = db
    .query("SELECT * FROM conversation_ledger WHERE conversation_id='c-fix'")
    .get() as {
    seq: number;
    content: string;
  };
  expect(ledger.seq).toBe(1);
  expect(ledger.content).toContain("hello");

  // session_id column is gone
  const memCols = db.query("PRAGMA table_info('member')").all() as { name: string }[];
  expect(memCols.map((c) => c.name)).not.toContain("session_id");

  // No Context/Branch backfilled for existing member
  const trees = db.query("SELECT * FROM agent_context_tree WHERE conversation_id='c-fix'").all();
  expect(trees).toHaveLength(0);

  // Migration is forward-only; reopening via openDb would re-run drizzle's
  // migrator which tracks its own ledger. The raw-SQL upgrade path above is
  // what matters: product facts survive and no Context is backfilled.

  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Phase 6: legacy execution audit deletion ─────────────────

/** Build a pre-0020 fixture (all migrations 0000-0019 applied) with the full
 *  Product fact set PLUS the legacy audit rows that 0020 must delete:
 *  span/attempt/control_plane_event/span_origin rows and ledger span_id. */
function buildPhase6PreMigrationFixture(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsDir =
    ["drizzle/backend", "apps/backend/drizzle/backend"].find((p) => existsSync(p)) ??
    "drizzle/backend";
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && f < "0020_")
    .sort();
  for (const f of files) {
    const sql = readFileSync(`${migrationsDir}/${f}`, "utf8");
    const stmts = sql
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter((s) => s);
    for (const s of stmts) {
      try {
        db.exec(s);
      } catch {
        /* may already exist */
      }
    }
  }

  // ── Product facts (the set 0020 must preserve untouched) ──
  db.exec(
    "INSERT INTO agents (id, name, template, workspace_path, model_provider, model_name, permission_mode, max_steps, created_at, updated_at, lark_enabled) VALUES ('ag-p6', 'P6Agent', NULL, '/tmp/p6', 'anthropic', 'claude-sonnet-4-6', 'ask', 10, 1000, 1000, 0)",
  );
  db.exec(
    "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, title, origin, created_at) VALUES ('c-p6', 'mention', 1, 'P6 Conv', 'user', 1000)",
  );
  db.exec(
    "INSERT INTO member (member_id, conversation_id, kind, agent_id, user_ref, display_name, joined_at) VALUES ('m-human', 'c-p6', 'human', NULL, 'u1', 'H', 1000), ('m-agent', 'c-p6', 'agent', 'ag-p6', NULL, 'P6Agent', 1000)",
  );
  // Canonical Conversation History: two ledger messages, one carrying the
  // legacy span_id and the other the terminal-commit agent_run_id.
  db.exec(
    "INSERT INTO conversation_ledger (conversation_id, sender_member_id, addressed_to, kind, content, ts, span_id, agent_run_id, undone) VALUES ('c-p6', 'm-human', '[]', 'message', '{\"text\":\"hello\"}', 1000, 'sp-legacy-1', NULL, 0)",
  );
  db.exec(
    "INSERT INTO conversation_ledger (conversation_id, sender_member_id, addressed_to, kind, content, ts, span_id, agent_run_id, undone) VALUES ('c-p6', 'm-agent', '[]', 'message', '{\"text\":\"done\"}', 2000, 'sp-legacy-2', 'run-p6-1', 0)",
  );
  // Agent Context tree/branch/entries
  db.exec(
    "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('tree-p6', 'c-p6', 'm-agent', 1000)",
  );
  db.exec(
    "INSERT INTO agent_context_branch (branch_id, tree_id, leaf_entry_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('branch-p6', 'tree-p6', NULL, 2, 'oma', 1, 1, 1000)",
  );
  db.exec(
    "INSERT INTO agent_context_entry (entry_id, tree_id, parent_id, type, payload, ledger_seq, created_at) VALUES ('entry-p6-1', 'tree-p6', NULL, 'private_message', '{\"note\":\"first\"}', NULL, 1000), ('entry-p6-2', 'tree-p6', 'entry-p6-1', 'ledger_message', '{\"seq\":1}', 1, 1000)",
  );
  // Agent Run + branch input queue
  db.exec(
    "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, terminal_result, config_revision, system_prompt, skill_roots, created_at, terminal_at) VALUES ('run-p6-1', 'branch-p6', 'c-p6', 'm-agent', '{\"backendKind\":\"oma\",\"modelId\":\"claude-sonnet-4-6\"}', 'completed', 'ik-p6-1', '{\"status\":\"completed\"}', 1, 'sys-p6', '[\"/p6/skills\"]', 1000, 2000)",
  );
  db.exec(
    "INSERT INTO branch_input_queue (input_id, branch_id, mode, message, status, delivery_idempotency_key, input_idempotency_key, run_id, model_ref, config_revision, created_at) VALUES ('in-p6', 'branch-p6', 'normal', '{\"text\":\"next\"}', 'delivered', 'del-p6', 'iid-p6', 'run-p6-1', '{\"backendKind\":\"oma\",\"modelId\":\"claude-sonnet-4-6\"}', 1, 1000)",
  );
  db.exec(
    "INSERT INTO product_tool_call (run_id, call_id, tool_name, input_hash, status, result, created_at, completed_at) VALUES ('run-p6-1', 'call-p6', 'history_retain', 'h1', 'completed', '{\"ok\":true}', 1000, 1500)",
  );
  // Loop items/budget
  db.exec(
    "INSERT INTO loop_item (loop_id, item_id, source, summary, step, attempt, priority, result, updated_at) VALUES ('loop-p6', 'item-p6', 'issue', 'fix', 'fixing', 1, 3, NULL, 1000)",
  );
  db.exec("INSERT INTO loop_budget (loop_id, day, spent) VALUES ('loop-p6', '2026-08-05', 500)");
  // Skill Packs + assignment
  db.exec(
    "INSERT INTO skill_pack (id, name, description, source_kind, status, created_at, updated_at) VALUES ('pack-p6', 'loop-engine', 'Loop skill', 'builtin', 'ready', 1000, 1000)",
  );
  db.exec(
    "INSERT INTO agent_skill_pack (agent_id, pack_id, created_at) VALUES ('ag-p6', 'pack-p6', 1000)",
  );
  // Cron Jobs / Projects / Settings / Surface Health
  db.exec(
    "INSERT INTO cron_job (cron_job_id, name, agent_id, cron_expr, prompt, enabled, timeout_ms, max_retries, created_at, updated_at) VALUES ('cron-p6', 'daily', 'ag-p6', '0 9 * * *', 'do', 1, 30000, 1, 1000, 1000)",
  );
  db.exec(
    "INSERT INTO project (project_id, name, auto_orchestrate, created_at, updated_at) VALUES ('proj-p6', 'p6', 0, 1000, 1000)",
  );
  db.exec("INSERT INTO settings (key, value, updated_at) VALUES ('p6.key', 'false', 1000)");
  db.exec(
    "INSERT INTO surface_health (agent_id, surface, status, last_seen_at, payload, updated_at) VALUES ('ag-p6', 'lark', 'running', 1000, '{}', 1000)",
  );

  // ── Legacy audit rows (0020 must DELETE these, no conversion) ──
  db.exec(
    "INSERT INTO span (span_id, session_id, status, kind, agent_id, started_at) VALUES ('sp-legacy-1', 'sess-legacy', 'succeeded', 'main', 'ag-p6', 1000), ('sp-legacy-2', 'sess-legacy', 'succeeded', 'main', 'ag-p6', 2000)",
  );
  db.exec(
    "INSERT INTO attempt (span_id, seq, started_at, ended_at) VALUES ('sp-legacy-1', 0, 1000, 2000)",
  );
  db.exec(
    "INSERT INTO control_plane_event (span_id, attempt_seq, kind, payload, ts) VALUES ('sp-legacy-1', 0, 'retry_requested', '{}', 1000)",
  );
  db.exec(
    "INSERT INTO span_origin (span_id, conversation_id, source_ledger_seq, agent_member_id, surface, idempotency_key, created_at) VALUES ('sp-legacy-1', 'c-p6', 1, 'm-agent', 'web', 'ik-sp', 1000)",
  );
  db.close();
}

test("Phase 6: product facts survive 0020 migration, legacy audit deleted, no Context backfill", () => {
  const tmpPath = `/tmp/test-backend-db-p6-upgrade-${Math.random().toString(36).slice(2, 8)}.db`;
  buildPhase6PreMigrationFixture(tmpPath);

  const db = new Database(tmpPath);
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsDir =
    ["drizzle/backend", "apps/backend/drizzle/backend"].find((p) => existsSync(p)) ??
    "drizzle/backend";
  const sql0020 = readFileSync(`${migrationsDir}/0020_phase6_drop_legacy_execution.sql`, "utf8");
  for (const s of sql0020
    .split("--> statement-breakpoint")
    .map((s: string) => s.replace(/^--.*$/gm, "").trim())
    .filter((s: string) => s)) {
    db.exec(s);
  }

  // 1. Legacy audit tables are gone, rows discarded (not converted).
  const names = (
    db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((t) => t.name);
  expect(names).not.toContain("span");
  expect(names).not.toContain("attempt");
  expect(names).not.toContain("control_plane_event");
  expect(names).not.toContain("span_origin");

  // 2. conversation_ledger lost span_id + idx_ledger_run; agent_run_id kept.
  const ledgerCols = (
    db.query("PRAGMA table_info('conversation_ledger')").all() as { name: string }[]
  ).map((c) => c.name);
  expect(ledgerCols).not.toContain("span_id");
  expect(ledgerCols).toContain("agent_run_id");
  const idx = (
    db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
  ).map((i) => i.name);
  expect(idx).not.toContain("idx_ledger_run");
  expect(idx).toContain("idx_ledger_agent_run");

  // 3. Product facts: rows + PKs preserved per table.
  const expectRows = (table: string, n: number) => {
    const count = (db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    expect(count, `${table} row count`).toBe(n);
  };
  expectRows("agents", 1);
  expectRows("conversation", 1);
  expectRows("member", 2);
  expectRows("conversation_ledger", 2);
  expectRows("agent_context_tree", 1);
  expectRows("agent_context_branch", 1);
  expectRows("agent_context_entry", 2);
  expectRows("agent_run", 1);
  expectRows("branch_input_queue", 1);
  expectRows("product_tool_call", 1);
  expectRows("loop_item", 1);
  expectRows("loop_budget", 1);
  expectRows("skill_pack", 1);
  expectRows("agent_skill_pack", 1);
  expectRows("cron_job", 1);
  expectRows("project", 1);
  expectRows("settings", 1);
  expectRows("surface_health", 1);

  const run = db.query("SELECT * FROM agent_run WHERE run_id='run-p6-1'").get() as {
    run_id: string;
    status: string;
    system_prompt: string;
    idempotency_key: string;
  };
  expect(run.run_id).toBe("run-p6-1");
  expect(run.status).toBe("completed");
  expect(run.system_prompt).toBe("sys-p6");
  expect(run.idempotency_key).toBe("ik-p6-1");

  // 4. Conversation replay unchanged: same seq/content, agent_run_id kept.
  const ledger = db
    .query("SELECT * FROM conversation_ledger WHERE conversation_id='c-p6' ORDER BY seq")
    .all() as Array<{ seq: number; content: string; agent_run_id: string | null }>;
  expect(ledger).toHaveLength(2);
  expect(ledger[0]!.seq).toBe(1);
  expect(ledger[0]!.content).toBe('{"text":"hello"}');
  expect(ledger[0]!.agent_run_id).toBeNull();
  expect(ledger[1]!.seq).toBe(2);
  expect(ledger[1]!.content).toBe('{"text":"done"}');
  expect(ledger[1]!.agent_run_id).toBe("run-p6-1");

  // 5. No checkpoint/span data copied into Agent Context: entry set unchanged.
  const entries = db
    .query("SELECT * FROM agent_context_entry WHERE tree_id='tree-p6' ORDER BY entry_id")
    .all() as Array<{ entry_id: string; payload: string }>;
  expect(entries).toHaveLength(2);
  expect(entries[0]!.payload).toBe('{"note":"first"}');
  expect(entries[1]!.payload).toBe('{"seq":1}');

  // 6. Next Agent Run still buildable: queue row + branch + context intact.
  const queue = db.query("SELECT * FROM branch_input_queue WHERE input_id='in-p6'").get() as {
    branch_id: string;
    run_id: string | null;
    message: string;
  };
  expect(queue.branch_id).toBe("branch-p6");
  expect(queue.run_id).toBe("run-p6-1");
  expect(queue.message).toBe('{"text":"next"}');
  const branch = db
    .query("SELECT * FROM agent_context_branch WHERE branch_id='branch-p6'")
    .get() as { ledger_cursor: number; backend_kind: string };
  expect(branch.ledger_cursor).toBe(2);
  expect(branch.backend_kind).toBe("oma");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("Phase 1 constraints", () => {
  test("duplicate tree for one conversation fails (1:1, single-key)", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, hop_count, created_at) VALUES ('c1', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t1', 'c1', 1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t2', 'c1', 2)",
      ),
    ).toThrow();
    db.close();
  });

  test("two active runs on one branch fails; terminal historical runs coexist", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, hop_count, created_at) VALUES ('c2', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t2', 'c2', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b2', 't2', 0, 'fake', 1, 1, 1)",
    );
    // First active run
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r1', 'b2', 'c2', 'a2', '{}', 'running', 'k1', 1, 1)",
    );
    // Second active run on same branch must fail
    expect(() =>
      db.exec(
        "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r2', 'b2', 'c2', 'a2', '{}', 'waiting', 'k2', 1, 2)",
      ),
    ).toThrow();
    // Terminal the first run, then a new active run should succeed
    db.exec("UPDATE agent_run SET status='completed', terminal_at=2 WHERE run_id='r1'");
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r3', 'b2', 'c2', 'a2', '{}', 'running', 'k3', 1, 3)",
    );
    // Historical terminal run coexists
    const runs = db
      .query("SELECT run_id FROM agent_run WHERE branch_id='b2' ORDER BY created_at")
      .all();
    expect(runs).toHaveLength(2);
    db.close();
  });

  test("duplicate run idempotency key and queue delivery key fail", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, hop_count, created_at) VALUES ('c3', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t3', 'c3', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b3', 't3', 0, 'fake', 1, 1, 1)",
    );
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r3', 'b3', 'c3', 'a3', '{}', 'running', 'dup-key', 1, 1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r4', 'b3', 'c3', 'a3', '{}', 'running', 'dup-key', 1, 2)",
      ),
    ).toThrow();

    db.exec(
      "INSERT INTO branch_input_queue (input_id, branch_id, mode, message, status, delivery_idempotency_key, input_idempotency_key, created_at) VALUES ('q1', 'b3', 'normal', '{}', 'pending', 'dup-delivery', 'ikey-q1', 1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO branch_input_queue (input_id, branch_id, mode, message, status, delivery_idempotency_key, input_idempotency_key, created_at) VALUES ('q2', 'b3', 'normal', '{}', 'pending', 'dup-delivery', 'ikey-q2', 2)",
      ),
    ).toThrow();
    db.close();
  });
  test("deleting a conversation cascades through Agent Context records", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, hop_count, created_at) VALUES ('c4', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, created_at) VALUES ('t4', 'c4', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b4', 't4', 0, 'fake', 1, 1, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_entry (entry_id, tree_id, parent_id, type, payload, created_at) VALUES ('e4', 't4', NULL, 'private_message', '{}', 1)",
    );
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r5', 'b4', 'c4', 'a4', '{}', 'completed', 'k5', 1, 1)",
    );

    // Delete conversation cascades to tree -> branch -> entry, run
    db.exec("DELETE FROM conversation WHERE conversation_id='c4'");
    expect(db.query("SELECT * FROM agent_context_tree WHERE tree_id='t4'").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM agent_context_branch WHERE branch_id='b4'").all()).toHaveLength(
      0,
    );
    expect(db.query("SELECT * FROM agent_context_entry WHERE entry_id='e4'").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM agent_run WHERE run_id='r5'").all()).toHaveLength(0);
    db.close();
  });
});

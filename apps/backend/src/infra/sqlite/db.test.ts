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
  // S1: events.db merged — run/attempt are now in backend.db
  expect(names).toContain("span");
  expect(names).toContain("attempt");
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

test("M10 conversation/member/conversation_ledger tables exist after migration", () => {
  const tmpPath = `/tmp/test-backend-db-m10-${Math.random().toString(36).slice(2, 8)}.db`;
  const db = openDb(tmpPath);

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("conversation");
  expect(names).toContain("member");
  expect(names).toContain("conversation_ledger");

  // Verify conversation table shape
  const convCols = db.query("PRAGMA table_info('conversation')").all() as { name: string }[];
  expect(convCols.map((c) => c.name)).toContain("trigger_mode");
  expect(convCols.map((c) => c.name)).toContain("hop_count");

  // Verify member table shape
  const memCols = db.query("PRAGMA table_info('member')").all() as { name: string }[];
  expect(memCols.map((c) => c.name)).toContain("conversation_id");
  expect(memCols.map((c) => c.name)).toContain("kind");

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
  "backend_session_binding",
  "agent_run",
  "branch_input_queue",
  "pending_action",
] as const;

test("Phase 1: fresh migration creates seven tables and active-branch index, drops session_id", () => {
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

  // member.session_id must be gone
  const memCols = db.query("PRAGMA table_info('member')").all() as { name: string }[];
  expect(memCols.map((c) => c.name)).not.toContain("session_id");

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

// ─── Phase 1 constraints ───────────────────────────────────────

describe("Phase 1 constraints", () => {
  test("duplicate (conversation_id, agent_member_id) tree fails", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES ('c1', 'mention', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('t1', 'c1', 'm1', 1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('t2', 'c1', 'm1', 2)",
      ),
    ).toThrow();
    db.close();
  });

  test("two active runs on one branch fails; terminal historical runs coexist", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES ('c2', 'mention', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('t2', 'c2', 'm2', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b2', 't2', 0, 'fake', 1, 1, 1)",
    );
    // First active run
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r1', 'b2', 'c2', 'm2', '{}', 'running', 'k1', 1, 1)",
    );
    // Second active run on same branch must fail
    expect(() =>
      db.exec(
        "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r2', 'b2', 'c2', 'm2', '{}', 'waiting', 'k2', 1, 2)",
      ),
    ).toThrow();
    // Terminal the first run, then a new active run should succeed
    db.exec("UPDATE agent_run SET status='completed', terminal_at=2 WHERE run_id='r1'");
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r3', 'b2', 'c2', 'm2', '{}', 'running', 'k3', 1, 3)",
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
      "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES ('c3', 'mention', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('t3', 'c3', 'm3', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b3', 't3', 0, 'fake', 1, 1, 1)",
    );
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r3', 'b3', 'c3', 'm3', '{}', 'running', 'dup-key', 1, 1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r4', 'b3', 'c3', 'm3', '{}', 'running', 'dup-key', 1, 2)",
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
      "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES ('c4', 'mention', 0, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_tree (tree_id, conversation_id, agent_member_id, created_at) VALUES ('t4', 'c4', 'm4', 1)",
    );
    db.exec(
      "INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at) VALUES ('b4', 't4', 0, 'fake', 1, 1, 1)",
    );
    db.exec(
      "INSERT INTO agent_context_entry (entry_id, tree_id, parent_id, type, payload, created_at) VALUES ('e4', 't4', NULL, 'private_message', '{}', 1)",
    );
    db.exec(
      "INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_member_id, model_ref, status, idempotency_key, config_revision, created_at) VALUES ('r5', 'b4', 'c4', 'm4', '{}', 'completed', 'k5', 1, 1)",
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

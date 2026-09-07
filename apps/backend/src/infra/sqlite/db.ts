import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../db/schema.js";

export function openDb(dbPath: string): Database {
  // Ensure parent directory exists (SQLite doesn't create it)
  const dir = path.dirname(dbPath);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true });

  // M17: provider keys and session data live in this DB in plaintext.
  // Owner-only on dir + files, every open (fixes legacy 0644 files too).
  // In-memory DBs (":memory:", tests) must not chmod the process cwd, and
  // pre-existing dirs (e.g. /tmp) are never touched.
  const inMemory = dbPath === ":memory:";
  if (!inMemory && !dirExisted) {
    chmodSync(dir, 0o700);
  }

  const sqlite = new Database(dbPath);
  if (!inMemory) {
    chmodSync(dbPath, 0o600);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
  }
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  // Phase 1: foreign keys ON so cascade deletes and FK constraints are enforced
  // in every transaction; busy_timeout lets a competing writer wait briefly
  // instead of failing immediately under concurrent acquire/commit.
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");

  // Run drizzle-kit migrations (replaces hand-rolled ALL_MIGRATIONS + _migrations ledger).
  // The schema is used only for the drizzle instance type; migrate() reads SQL files
  // from the migrations folder and tracks applied migrations in __drizzle_migrations__.
  const db = drizzle(sqlite, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../../../drizzle/backend");
  migrate(db, { migrationsFolder });

  return sqlite;
}

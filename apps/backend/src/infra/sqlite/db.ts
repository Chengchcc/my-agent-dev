import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../db/schema.js";

export function openDb(dbPath: string): Database {
  // Ensure parent directory exists (SQLite doesn't create it)
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);

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

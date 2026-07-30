import { unlinkSync } from "node:fs";
import { runSessionStoreContract } from "./session-store.contract.js";
import { createSqliteSessionStore } from "./sqlite-session-store.js";

const dbPath = `/tmp/test-session-store-${Math.random().toString(36).slice(2, 10)}.db`;

runSessionStoreContract(
  "SQLite",
  async () => createSqliteSessionStore(dbPath),
  async () => {
    try {
      unlinkSync(dbPath);
    } catch {
      /* cleanup */
    }
  },
);

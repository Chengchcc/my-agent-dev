import { Database } from "bun:sqlite";
import type { SessionStorage } from "./session-storage.js";
import type { SessionTreeEntry } from "./session-tree.js";

export interface SqliteSessionStorageOptions {
  db: Database | string;
  sessionId: string;
}

/** Ensure session_tree + session_metadata tables exist. Idempotent.
 *  session_metadata carries leaf_id (SessionStorage) + created_at/updated_at
 *  (SessionRepo). The timestamp columns are added via ALTER TABLE for DBs
 *  created before they existed. */
export function ensureSessionSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS session_tree (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_tree_session ON session_tree(session_id);
    CREATE TABLE IF NOT EXISTS session_metadata (
      session_id TEXT PRIMARY KEY,
      leaf_id TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
  // ponytail: migrate legacy DBs -- ALTER TABLE ADD COLUMN has no IF NOT EXISTS,
  // so probe pragma_table_info. Cheaper than try/catch per column.
  const cols = db
    .prepare<{ name: string }, []>("SELECT name FROM pragma_table_info('session_metadata')")
    .all()
    .map((r) => r.name);
  if (!cols.includes("created_at")) {
    db.run("ALTER TABLE session_metadata ADD COLUMN created_at INTEGER");
  }
  if (!cols.includes("updated_at")) {
    db.run("ALTER TABLE session_metadata ADD COLUMN updated_at INTEGER");
  }
}

interface SessionTreeRow {
  id: string;
  parent_id: string | null;
  type: string;
  timestamp: number;
  data: string;
}
interface LeafRow {
  leaf_id: string | null;
}

/**
 * SQLite 实现 -- 每个实例绑定一个 sessionId。
 * leafId 存 session_metadata 表，entries 存 session_tree 表。
 *
 * ponytail: 直接用 bun:sqlite prepared statements + 数组绑定（对象命名绑定
 * 在 bun:sqlite 行为不稳），不走 drizzle-kit 迁移；schema 极简且独立。
 */
export function sqliteSessionStorage(opts: SqliteSessionStorageOptions): SessionStorage {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  ensureSessionSchema(db);
  const sessionId = opts.sessionId;

  const selectLeafRow = db.prepare("SELECT leaf_id FROM session_metadata WHERE session_id = ?");
  const upsertLeaf = db.prepare(
    "INSERT INTO session_metadata (session_id, leaf_id, updated_at) " +
      "VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET leaf_id = excluded.leaf_id, " +
      "updated_at = excluded.updated_at",
  );
  const insertEntry = db.prepare(
    "INSERT INTO session_tree (id, session_id, parent_id, type, timestamp, data) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectEntry = db.prepare(
    "SELECT id, parent_id, type, timestamp, data FROM session_tree WHERE id = ? AND session_id = ?",
  );
  const selectAllBySession = db.prepare(
    "SELECT id, parent_id, type, timestamp, data FROM session_tree WHERE session_id = ? ORDER BY timestamp ASC",
  );

  const parseRow = (row: SessionTreeRow): SessionTreeEntry => {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    return {
      ...data,
      type: row.type,
      id: row.id,
      parentId: row.parent_id,
      timestamp: row.timestamp,
    } as SessionTreeEntry;
  };

  return {
    getLeafId() {
      const row = selectLeafRow.get(sessionId) as LeafRow | null;
      return row ? row.leaf_id : null;
    },
    async setLeafId(id) {
      upsertLeaf.run(sessionId, id, Date.now());
    },
    createEntryId() {
      return crypto.randomUUID();
    },
    async appendEntry(entry) {
      if (entry.parentId !== null) {
        const parent = selectEntry.get(entry.parentId, sessionId) as SessionTreeRow | null;
        if (!parent) {
          throw new Error(`sqliteSessionStorage.appendEntry: parentId ${entry.parentId} not found`);
        }
      }
      const { type, id, parentId, timestamp, ...data } = entry;
      insertEntry.run(id, sessionId, parentId, type, timestamp, JSON.stringify(data));
    },
    getEntry(id) {
      const row = selectEntry.get(id, sessionId) as SessionTreeRow | null;
      return row ? parseRow(row) : undefined;
    },
    getPathToRoot(fromLeafId) {
      if (fromLeafId === null) return [];
      const chain: SessionTreeEntry[] = [];
      let curId: string | null = fromLeafId;
      // ponytail: 简单回溯，无环检测 -- parentId 约束由 appendEntry 保证
      while (curId !== null) {
        const row = selectEntry.get(curId, sessionId) as SessionTreeRow | null;
        if (!row) break;
        const entry = parseRow(row);
        chain.push(entry);
        curId = entry.parentId;
      }
      return chain.reverse();
    },
    getEntries() {
      return (selectAllBySession.all(sessionId) as SessionTreeRow[]).map(parseRow);
    },
  };
}

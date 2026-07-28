import { Database } from "bun:sqlite";
import { Session } from "./session.js";
import type { SessionMetadata, SessionRepo } from "./session-repo.js";
import type { SessionTreeEntry } from "./session-tree.js";
import { ensureSessionSchema, sqliteSessionStorage } from "./sqlite-session-storage.js";

export interface SqliteSessionRepoOptions {
  db: Database | string;
}

interface MetadataRow {
  session_id: string;
  leaf_id: string | null;
  created_at: number | null;
  updated_at: number | null;
}

/**
 * SqliteSessionRepo -- 一个 DB 文件承载所有会话。
 *
 * session_tree 表存所有会话的条目（按 session_id 隔离），session_metadata
 * 存每个会话的 leaf_id + 时间戳。Session 实例通过 sqliteSessionStorage
 * 绑定到具体 sessionId。
 *
 * ponytail: 直接用 bun:sqlite prepared statements，复用 ensureSessionSchema；
 * 不走 drizzle-kit 迁移 -- schema 由 sqliteSessionStorage 管理。
 */
export function sqliteSessionRepo(opts: SqliteSessionRepoOptions): SessionRepo {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  ensureSessionSchema(db);

  const selectMeta = db.prepare<MetadataRow, [string]>(
    "SELECT session_id, leaf_id, created_at, updated_at " +
      "FROM session_metadata WHERE session_id = ?",
  );
  const insertMeta = db.prepare<Record<string, never>, [string, string | null, number, number]>(
    "INSERT INTO session_metadata (session_id, leaf_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?)",
  );
  const deleteTree = db.prepare<Record<string, never>, [string]>(
    "DELETE FROM session_tree WHERE session_id = ?",
  );
  const deleteMeta = db.prepare<Record<string, never>, [string]>(
    "DELETE FROM session_metadata WHERE session_id = ?",
  );
  const selectAllMeta = db.prepare<MetadataRow, []>(
    "SELECT session_id, leaf_id, created_at, updated_at " +
      "FROM session_metadata ORDER BY updated_at DESC",
  );

  const toMetadata = (row: MetadataRow): SessionMetadata => ({
    id: row.session_id,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? row.created_at ?? 0,
  });

  // ponytail: bun:sqlite is synchronous, so create/open are effectively sync.
  // SessionRepo interface declares Promise<Session> (async contract for future
  // non-sqlite backends), but SqliteSessionManager must stay sync (ADR 0012:
  // changing sessionManager.create() to async was explicitly rejected).
  // Expose sync helpers for the sync manager; async methods satisfy the interface.
  const createSync = (options?: { id?: string }): Session => {
    const sessionId = options?.id ?? crypto.randomUUID();
    const now = Date.now();
    insertMeta.run(sessionId, null, now, now);
    const storage = sqliteSessionStorage({ db, sessionId });
    return new Session(storage);
  };

  const openSync = (sessionId: string): Session => {
    const row = selectMeta.get(sessionId);
    if (!row) {
      throw new Error(`sqliteSessionRepo.open: session ${sessionId} not found`);
    }
    const storage = sqliteSessionStorage({ db, sessionId });
    return new Session(storage);
  };

  const forkSync = (sourceSessionId: string, options?: { entryId?: string }): Session => {
    const row = selectMeta.get(sourceSessionId);
    if (!row) {
      throw new Error(`sqliteSessionRepo.fork: source session ${sourceSessionId} not found`);
    }
    // 收集源会话从根到目标 entryId 的路径条目。
    const sourceStorage = sqliteSessionStorage({
      db,
      sessionId: sourceSessionId,
    });
    const targetLeafId = options?.entryId ?? sourceStorage.getLeafId();
    const path: SessionTreeEntry[] = sourceStorage.getPathToRoot(targetLeafId);

    // 创建新会话，复制路径条目 -- 生成新 id 并重映射 parentId。
    const newSessionId = crypto.randomUUID();
    const now = Date.now();
    insertMeta.run(newSessionId, null, now, now);
    const newStorage = sqliteSessionStorage({ db, sessionId: newSessionId });
    const idMap = new Map<string, string>();
    let newLeafId: string | null = null;

    for (const entry of path) {
      const newId = newStorage.createEntryId();
      idMap.set(entry.id, newId);
      const newParentId = entry.parentId === null ? null : (idMap.get(entry.parentId) ?? null);
      const copied: SessionTreeEntry = {
        ...entry,
        id: newId,
        parentId: newParentId,
      };
      newStorage.appendEntry(copied);
      newLeafId = newId;
    }

    newStorage.setLeafId(newLeafId);
    return new Session(newStorage);
  };

  return {
    create: (options) => Promise.resolve(createSync(options)),
    open: (sessionId) => Promise.resolve(openSync(sessionId)),
    list: () => Promise.resolve(selectAllMeta.all().map(toMetadata)),
    delete: (sessionId) => {
      deleteTree.run(sessionId);
      deleteMeta.run(sessionId);
      return Promise.resolve();
    },
    fork: (sourceSessionId, options) => Promise.resolve(forkSync(sourceSessionId, options)),
    // Sync helpers for SqliteSessionManager (ADR 0012: manager stays sync).
    createSync,
    openSync,
    forkSync,
  } as SessionRepo & {
    createSync(options?: { id?: string }): Session;
    openSync(sessionId: string): Session;
    forkSync(sourceSessionId: string, options?: { entryId?: string }): Session;
  };
}

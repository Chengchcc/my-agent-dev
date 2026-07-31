import { Database } from "bun:sqlite";
import type { AppendBatchInput, AppendBatchResult, SessionStore } from "./session-store.js";
import type {
  CodingSessionEntry,
  CodingSessionMetadata,
  CodingSessionSnapshot,
} from "./session-tree.js";

function schema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    session_id TEXT PRIMARY KEY,
    backend_kind TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    model_ref TEXT NOT NULL,
    system_prompt_hash TEXT,
    active_loop_id TEXT,
    leaf_entry_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS entries (
    entry_id TEXT PRIMARY KEY,
    parent_id TEXT,
    product_entry_id TEXT UNIQUE,
    type TEXT NOT NULL,
    role TEXT,
    source TEXT,
    message TEXT,
    state TEXT,
    summary TEXT,
    covers_entry_ids TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS operations (
    entry_id TEXT NOT NULL,
    from_leaf_id TEXT,
    op_type TEXT NOT NULL DEFAULT 'leaf_moved'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entries_product ON entries(product_entry_id) WHERE product_entry_id IS NOT NULL",
  );
}

export function createSqliteSessionStore(dbPath: string): SessionStore {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  schema(db);

  let boundSessionId: string | null = null;

  function guard(sessionId: string): void {
    if (boundSessionId === null) {
      boundSessionId = sessionId;
      return;
    }
    if (sessionId !== boundSessionId) {
      throw new Error(`SQLite store bound to ${boundSessionId}, rejected ${sessionId}`);
    }
  }
  return {
    async create(metadata: CodingSessionMetadata): Promise<void> {
      guard(metadata.sessionId);
      db.transaction(() => {
        db.query(`INSERT INTO meta (session_id, backend_kind, workspace_root, model_ref, system_prompt_hash, active_loop_id, leaf_entry_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).run(
          metadata.sessionId,
          metadata.backendKind,
          metadata.workspaceRoot,
          JSON.stringify(metadata.modelRef),
          metadata.systemPromptHash,
          metadata.activeLoopId,
          metadata.leafEntryId,
          metadata.createdAt,
          metadata.updatedAt,
        );
      })();
    },
    async open(sessionId: string): Promise<CodingSessionSnapshot> {
      guard(sessionId);
      const meta = db.query("SELECT * FROM meta WHERE session_id = ?").get(sessionId) as Record<
        string,
        unknown
      > | null;
      if (!meta) throw new Error(`Session ${sessionId} not found`);

      const entries = db.query("SELECT * FROM entries ORDER BY created_at").all() as Array<
        Record<string, unknown>
      >;
      const ops = db.query("SELECT * FROM operations").all() as Array<Record<string, unknown>>;

      // Rebuild leaf cache from operations log when cache is absent or stale
      let leafId = meta.leaf_entry_id as string | null;
      const parsedOps = ops.map((o) => ({
        type: "leaf_moved" as const,
        entryId: o.entry_id as string,
        fromLeafId: o.from_leaf_id as string | null,
      }));
      // If leaf cache is null but operations exist, repair from last operation
      if (!leafId && parsedOps.length > 0) {
        leafId = parsedOps[parsedOps.length - 1]!.entryId;
      }
      // Verify leaf points to an existing entry; if stale, use latest entry
      if (leafId) {
        const leafExists = entries.some((e) => e.entry_id === leafId);
        if (!leafExists && entries.length > 0) {
          leafId = entries[entries.length - 1]!.entry_id as string;
        }
      }

      return {
        metadata: {
          sessionId: meta.session_id as string,
          backendKind: meta.backend_kind as string,
          workspaceRoot: meta.workspace_root as string,
          modelRef: JSON.parse(meta.model_ref as string),
          systemPromptHash: meta.system_prompt_hash as string | null,
          activeLoopId: meta.active_loop_id as string | null,
          leafEntryId: leafId,
          createdAt: meta.created_at as number,
          updatedAt: meta.updated_at as number,
        },
        entries: entries.map(parseEntry),
        operations: parsedOps,
      };
    },
    async delete(sessionId: string): Promise<void> {
      guard(sessionId);
      db.exec("DELETE FROM entries");
      db.exec("DELETE FROM operations");
      db.exec("DELETE FROM meta WHERE session_id = ?", [sessionId]);
      db.close();
    },

    async appendBatch(sessionId: string, input: AppendBatchInput): Promise<AppendBatchResult> {
      guard(sessionId);
      return db.transaction(() => {
        const meta = db
          .query("SELECT leaf_entry_id FROM meta WHERE session_id = ?")
          .get(sessionId) as { leaf_entry_id: string | null };
        if (!meta) throw new Error(`Session ${sessionId} not found`);

        let parentId = meta.leaf_entry_id;
        const appendedIds: string[] = [];

        for (const entry of input.entries) {
          const productEntryId =
            "productEntryId" in entry
              ? (entry as { productEntryId?: string }).productEntryId
              : undefined;
          if (productEntryId) {
            const dup = db
              .query("SELECT entry_id FROM entries WHERE product_entry_id = ?")
              .get(productEntryId);
            if (dup) continue;
          }

          const entryId = crypto.randomUUID().replace(/-/g, "").slice(0, 26);
          const now = Date.now();
          const msg = "message" in entry ? (entry as { message: unknown }).message : null;

          db.query(`INSERT INTO entries (entry_id, parent_id, product_entry_id, type, role, source, message, state, summary, covers_entry_ids, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`).run(
            entryId,
            parentId,
            productEntryId ?? null,
            entry.type as string,
            (entry as { role?: string }).role ?? null,
            (entry as { source?: string }).source ?? null,
            msg ? JSON.stringify(msg) : null,
            (entry as { state?: unknown }).state
              ? JSON.stringify((entry as { state: unknown }).state)
              : null,
            (entry as { summary?: string }).summary ?? null,
            (entry as { coversEntryIds?: readonly string[] }).coversEntryIds
              ? JSON.stringify((entry as { coversEntryIds: readonly string[] }).coversEntryIds)
              : null,
            now,
          );

          appendedIds.push(entryId);
          parentId = entryId;
        }

        if (appendedIds.length > 0) {
          db.query("UPDATE meta SET leaf_entry_id = ?, updated_at = ? WHERE session_id = ?").run(
            parentId,
            Date.now(),
            sessionId,
          );
        }

        return { appendedIds } satisfies AppendBatchResult;
      })();
    },
    async moveLeaf(sessionId: string, entryId: string): Promise<void> {
      guard(sessionId);
      db.transaction(() => {
        const meta = db
          .query("SELECT leaf_entry_id FROM meta WHERE session_id = ?")
          .get(sessionId) as { leaf_entry_id: string | null } | null;
        if (!meta) throw new Error(`Session ${sessionId} not found`);
        const exists = db.query("SELECT entry_id FROM entries WHERE entry_id = ?").get(entryId);
        if (!exists) throw new Error(`Entry ${entryId} not found`);

        db.query(
          "INSERT INTO operations (entry_id, from_leaf_id, op_type) VALUES (?1, ?2, 'leaf_moved')",
        ).run(entryId, meta.leaf_entry_id);
        db.query("UPDATE meta SET leaf_entry_id = ?, updated_at = ? WHERE session_id = ?").run(
          entryId,
          Date.now(),
          sessionId,
        );
      })();
    },
    async readBranch(sessionId: string): Promise<readonly CodingSessionEntry[]> {
      guard(sessionId);
      const meta = db
        .query("SELECT leaf_entry_id FROM meta WHERE session_id = ?")
        .get(sessionId) as { leaf_entry_id: string | null } | null;
      if (!meta?.leaf_entry_id) return [];

      const all = db.query("SELECT * FROM entries").all() as Array<Record<string, unknown>>;
      const map = new Map(all.map((r) => [r.entry_id as string, r]));
      const result: CodingSessionEntry[] = [];
      let id: string | null = meta.leaf_entry_id;
      while (id) {
        const r = map.get(id);
        if (!r) break;
        result.push(parseEntry(r));
        id = r.parent_id as string | null;
      }
      return result.reverse();
    },
    async findByProductEntryIds(
      sessionId: string,
      ids: readonly string[],
    ): Promise<readonly CodingSessionEntry[]> {
      guard(sessionId);
      if (!ids.length) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .query(`SELECT * FROM entries WHERE product_entry_id IN (${placeholders})`)
        .all(...ids) as Array<Record<string, unknown>>;
      return rows.map(parseEntry);
    },
  };
}

function parseEntry(r: Record<string, unknown>): CodingSessionEntry {
  const base = {
    entryId: r.entry_id as string,
    parentId: r.parent_id as string | null,
    createdAt: r.created_at as number,
  };
  const type = r.type as string;
  if (type === "todo") {
    return {
      ...base,
      type: "todo",
      state: JSON.parse((r.state as string) ?? "{}"),
    } as CodingSessionEntry;
  }
  if (type === "compaction") {
    return {
      ...base,
      type: "compaction",
      summary: r.summary as string,
      coversEntryIds: JSON.parse((r.covers_entry_ids as string) ?? "[]"),
    } as CodingSessionEntry;
  }
  return {
    ...base,
    type: "message",
    productEntryId: r.product_entry_id as string | null,
    role: r.role as "user" | "assistant" | "system",
    source: r.source as string,
    message: JSON.parse((r.message as string) ?? "{}"),
  } as CodingSessionEntry;
}

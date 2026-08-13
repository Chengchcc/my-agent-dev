import type { Database } from "bun:sqlite";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { type AgentConfig, agentConfigSchema } from "./agent-config.js";
import type { AgentRow } from "./domain.js";
import type { AgentPort } from "./ports.js";

export function sqliteAgentAdapter(db: Database): AgentPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  function parseRow(row: typeof schema.agents.$inferSelect): AgentRow {
    return {
      id: row.id,
      workspacePath: row.workspacePath,
      // The config column is the materialized cache of the parsed
      // agent.yml; corrupt JSON is a bug, never a silent default.
      config: agentConfigSchema.parse(JSON.parse(row.config)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }

  return {
    async create(input: {
      id: string;
      workspacePath: string;
      config: AgentConfig;
      now: number;
    }): Promise<AgentRow> {
      d.insert(schema.agents)
        .values({
          id: input.id,
          workspacePath: input.workspacePath,
          config: JSON.stringify(input.config),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, input.id)).get();
      return parseRow(raw!);
    },

    async findById(id: string): Promise<AgentRow | null> {
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? parseRow(raw) : null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      const rows = includeArchived
        ? d.select().from(schema.agents).orderBy(desc(schema.agents.createdAt)).all()
        : d
            .select()
            .from(schema.agents)
            .where(isNull(schema.agents.archivedAt))
            .orderBy(desc(schema.agents.createdAt))
            .all();
      return rows.map(parseRow);
    },

    async update(
      id: string,
      input: { config: AgentConfig; now: number; workspacePath?: string },
    ): Promise<AgentRow | null> {
      const sets: Partial<typeof schema.agents.$inferInsert> = {
        config: JSON.stringify(input.config),
        updatedAt: input.now,
      };
      if (input.workspacePath !== undefined) sets.workspacePath = input.workspacePath;
      const rows = d
        .update(schema.agents)
        .set(sets)
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.archivedAt)))
        .returning()
        .all();
      if (rows.length === 0) return null;
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return parseRow(raw!);
    },

    async archive(id: string, now: number): Promise<AgentRow | null> {
      const rows = d
        .update(schema.agents)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.archivedAt)))
        .returning()
        .all();
      if (rows.length === 0) return null;
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return parseRow(raw!);
    },

    // M11: Permanent hard delete — all in single backend.db transaction.
    // Enable foreign_keys for CASCADE, then restore original value to avoid side effects.
    async hardDelete(
      id: string,
    ): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }> {
      const prevFk = db.query("PRAGMA foreign_keys").get() as { foreign_keys?: number } | null;
      const prev = prevFk?.foreign_keys ?? 0;
      db.run("PRAGMA foreign_keys = ON");
      try {
        const deletedMembers = db
          .prepare("SELECT COUNT(*) AS c FROM member WHERE agent_id = ?")
          .get(id) as { c: number };
        const deletedThreads = db
          .prepare("SELECT COUNT(*) AS c FROM thread WHERE agent_id = ?")
          .get(id) as { c: number };
        const deletedAgent = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
        return {
          deletedAgent: deletedAgent.changes > 0,
          deletedThreads: deletedThreads.c,
          deletedMembers: deletedMembers.c,
        };
      } finally {
        db.run(`PRAGMA foreign_keys = ${prev}`);
      }
    },
  };
}

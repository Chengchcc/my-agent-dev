import type { Database } from "bun:sqlite";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

export function sqliteAgentAdapter(db: Database): AgentPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async create(
      input: CreateAgentInput & {
        id: string;
        workspacePath: string;
        now: number;
        larkEnabled: boolean;
        larkAppId: string | null;
        larkProfileRef: string | null;
        larkBotDisplayName: string | null;
      },
    ): Promise<AgentRow> {
      d.insert(schema.agents)
        .values({
          id: input.id,
          name: input.name,
          template: input.template ?? null,
          workspacePath: input.workspacePath,
          modelProvider: input.model.provider,
          modelName: input.model.model,
          backendKind: input.backendKind ?? "coding_agent",
          reasoningEffort: input.reasoningEffort ?? null,
          permissionMode: input.permissionMode ?? "ask",
          maxSteps: input.maxSteps ?? null,
          larkEnabled: schema.boolToInt(input.larkEnabled),
          larkAppId: input.larkAppId ?? null,
          larkProfileRef: input.larkProfileRef ?? null,
          larkBotDisplayName: input.larkBotDisplayName ?? null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, input.id)).get();
      return schema.agentsSelectSchema.parse(raw!);
    },

    async findById(id: string): Promise<AgentRow | null> {
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? schema.agentsSelectSchema.parse(raw) : null;
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
      return rows.map((r) => schema.agentsSelectSchema.parse(r));
    },

    async update(
      id: string,
      input: UpdateAgentInput & { now: number; lark?: { profileRef?: string } },
    ): Promise<AgentRow | null> {
      const sets: Partial<typeof schema.agents.$inferInsert> = { updatedAt: input.now };
      if (input.name !== undefined) sets.name = input.name;
      if (input.model !== undefined) {
        sets.modelProvider = input.model.provider;
        sets.modelName = input.model.model;
      }
      if (input.backendKind !== undefined) sets.backendKind = input.backendKind;
      if (input.workspacePath !== undefined) sets.workspacePath = input.workspacePath;
      if (input.reasoningEffort !== undefined) sets.reasoningEffort = input.reasoningEffort;
      if (input.permissionMode !== undefined) sets.permissionMode = input.permissionMode;
      if (input.maxSteps !== undefined) sets.maxSteps = input.maxSteps;
      if (input.lark?.enabled !== undefined)
        sets.larkEnabled = schema.boolToInt(input.lark.enabled);
      if (input.lark?.appId !== undefined) sets.larkAppId = input.lark.appId;
      if (input.lark?.botDisplayName !== undefined) {
        sets.larkBotDisplayName = input.lark.botDisplayName;
      }
      if (input.lark?.profileRef !== undefined) sets.larkProfileRef = input.lark.profileRef;
      const rows = d
        .update(schema.agents)
        .set(sets)
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.archivedAt)))
        .returning()
        .all();

      if (rows.length === 0) return null;
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? schema.agentsSelectSchema.parse(raw) : null;
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
      return raw ? schema.agentsSelectSchema.parse(raw) : null;
    },

    // M11: Permanent hard delete — all in single backend.db transaction.
    // Enable foreign_keys for CASCADE, then restore original value to avoid side effects.
    async hardDelete(
      id: string,
    ): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }> {
      const prevFK = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys;
      // PRAGMA foreign_keys kept as raw db.exec — drizzle has no native PRAGMA abstraction.
      db.exec("PRAGMA foreign_keys = ON");

      const delAgent = db.transaction(() => {
        // Delete member rows (no FK, must be explicit; ledger messages preserved)
        const memberResult = db.run("DELETE FROM member WHERE agent_id = ?", [id]);
        const deletedMembers = memberResult.changes;

        // Delete the agent row
        const agentResult = db.run("DELETE FROM agents WHERE id = ?", [id]);
        const deletedAgent = agentResult.changes > 0;

        // projection_messages table removed (S2) — it was a redundant third copy of messages.
        // Canonical store: conversation_ledger (Product truth). Agent Context holds refs, not copies.

        return { deletedAgent, deletedThreads: 0, deletedMembers };
      });

      const result = delAgent();

      // Restore previous foreign_keys setting (avoid side effect on shared connection)
      if (!prevFK) db.exec("PRAGMA foreign_keys = OFF");

      return result;
    },
  };
}

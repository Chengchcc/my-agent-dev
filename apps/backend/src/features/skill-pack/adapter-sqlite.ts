import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { applyInstallTransition, type SkillPackRow } from "./entities.js";
import type { SkillPackPort } from "./ports.js";

export function sqliteSkillPackAdapter(db: Database): SkillPackPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async register(input): Promise<SkillPackRow> {
      d.insert(schema.skillPack)
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          sourceKind: input.sourceKind,
          sourceUrl: input.sourceUrl,
          versionRef: input.versionRef,
          installedRef: null,
          status: "pending",
          error: null,
          keepSynced: input.keepSynced ?? false,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      const raw = d.select().from(schema.skillPack).where(eq(schema.skillPack.id, input.id)).get();
      return schema.skillPackSelectSchema.parse(raw!);
    },

    async get(id: string): Promise<SkillPackRow | null> {
      const raw = d.select().from(schema.skillPack).where(eq(schema.skillPack.id, id)).get();
      return raw ? schema.skillPackSelectSchema.parse(raw) : null;
    },

    async list(): Promise<SkillPackRow[]> {
      const rows = d.select().from(schema.skillPack).all();
      return rows.map((r) => schema.skillPackSelectSchema.parse(r));
    },

    async applyInstallTransition(id, next, patch): Promise<SkillPackRow | null> {
      const row = await this.get(id);
      if (!row) return null;

      const result = applyInstallTransition(row.status, next, patch);

      d.update(schema.skillPack)
        .set({
          status: result.next,
          installedRef: result.installedRef ?? row.installedRef,
          error: result.error as string | null,
          updatedAt: patch?.now ?? Date.now(),
        })
        .where(eq(schema.skillPack.id, id))
        .run();

      return this.get(id);
    },

    async remove(id: string): Promise<boolean> {
      const result = d
        .delete(schema.skillPack)
        .where(eq(schema.skillPack.id, id))
        .returning()
        .all();
      return result.length > 0;
    },

    // ─── Agent assignments ───

    async listForAgent(agentId: string): Promise<SkillPackRow[]> {
      const rows = d
        .select({
          id: schema.skillPack.id,
          name: schema.skillPack.name,
          description: schema.skillPack.description,
          sourceKind: schema.skillPack.sourceKind,
          sourceUrl: schema.skillPack.sourceUrl,
          versionRef: schema.skillPack.versionRef,
          installedRef: schema.skillPack.installedRef,
          status: schema.skillPack.status,
          error: schema.skillPack.error,
          keepSynced: schema.skillPack.keepSynced,
          createdAt: schema.skillPack.createdAt,
          updatedAt: schema.skillPack.updatedAt,
        })
        .from(schema.agentSkillPack)
        .innerJoin(schema.skillPack, eq(schema.agentSkillPack.packId, schema.skillPack.id))
        .where(eq(schema.agentSkillPack.agentId, agentId))
        .all();
      return rows.map((r) => schema.skillPackSelectSchema.parse(r));
    },

    async setAgentPacks(agentId: string, packIds: string[], now: number): Promise<void> {
      d.delete(schema.agentSkillPack).where(eq(schema.agentSkillPack.agentId, agentId)).run();
      if (packIds.length === 0) return;
      d.insert(schema.agentSkillPack)
        .values(packIds.map((packId) => ({ agentId, packId, createdAt: now })))
        .run();
    },

    async removeAgentPack(packId: string): Promise<void> {
      d.delete(schema.agentSkillPack).where(eq(schema.agentSkillPack.packId, packId)).run();
    },
  };
}

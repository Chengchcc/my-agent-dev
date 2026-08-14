import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { knowledgePackSelectSchema } from "../../infra/db/schema.js";
import type { KnowledgePackRow } from "./entities.js";
import type { KnowledgePackPort } from "./ports.js";

export function sqliteKnowledgePackAdapter(db: Database): KnowledgePackPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  function toRow(r: unknown): KnowledgePackRow {
    const parsed = knowledgePackSelectSchema.parse(r);
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      sourceKind: parsed.sourceKind,
      sourceUrl: parsed.sourceUrl,
      versionRef: parsed.versionRef,
      installedRef: parsed.installedRef,
      status: parsed.status,
      error: parsed.error,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  }

  return {
    create(row: KnowledgePackRow): KnowledgePackRow {
      d.insert(schema.knowledgePack)
        .values({
          id: row.id,
          name: row.name,
          description: row.description,
          sourceKind: row.sourceKind,
          sourceUrl: row.sourceUrl,
          versionRef: row.versionRef,
          installedRef: row.installedRef,
          status: row.status,
          error: row.error,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        .run();
      return toRow(
        d.select().from(schema.knowledgePack).where(eq(schema.knowledgePack.id, row.id)).get()!,
      );
    },

    list(): KnowledgePackRow[] {
      return d.select().from(schema.knowledgePack).all().map(toRow);
    },

    getById(id: string): KnowledgePackRow | null {
      const row = d
        .select()
        .from(schema.knowledgePack)
        .where(eq(schema.knowledgePack.id, id))
        .get();
      return row ? toRow(row) : null;
    },

    update(id: string, patch: Partial<KnowledgePackRow>): KnowledgePackRow | null {
      const existing = this.getById(id);
      if (!existing) return null;
      d.update(schema.knowledgePack)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.installedRef !== undefined ? { installedRef: patch.installedRef } : {}),
          updatedAt: patch.updatedAt ?? Date.now(),
        })
        .where(eq(schema.knowledgePack.id, id))
        .run();
      return this.getById(id);
    },

    delete(id: string): boolean {
      const existing = this.getById(id);
      if (!existing) return false;
      d.delete(schema.knowledgePack).where(eq(schema.knowledgePack.id, id)).run();
      return true;
    },
  };
}

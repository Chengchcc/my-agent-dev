import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { projectSelectSchema } from "../../infra/db/schema.js";
import type { ProjectRow } from "./domain.js";
import type { CreateProjectRecord, ProjectPort, UpdateProjectRecord } from "./ports.js";

export function sqliteProjectAdapter(db: Database): ProjectPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    createProject(input: CreateProjectRecord): ProjectRow {
      const [r] = d
        .insert(schema.project)
        .values({
          projectId: input.projectId,
          name: input.name,
          repoUrl: input.repoUrl,
          defaultBranch: input.defaultBranch,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning()
        .all();
      return projectSelectSchema.parse(r!);
    },

    getProject(projectId: string): ProjectRow | null {
      const r = d
        .select()
        .from(schema.project)
        .where(eq(schema.project.projectId, projectId))
        .get();
      return r ? projectSelectSchema.parse(r) : null;
    },

    listProjects(): ProjectRow[] {
      const rows = d.select().from(schema.project).orderBy(sql`created_at DESC`).all();
      return rows.map((r) => projectSelectSchema.parse(r));
    },

    updateProject(projectId: string, patch: UpdateProjectRecord): ProjectRow | null {
      const sets: Record<string, unknown> = {};

      if (patch.name !== undefined) sets.name = patch.name;
      if (patch.repoUrl !== undefined) sets.repoUrl = patch.repoUrl;
      if (patch.defaultBranch !== undefined) sets.defaultBranch = patch.defaultBranch;

      if (Object.keys(sets).length === 0) {
        return this.getProject(projectId);
      }

      sets.updatedAt = patch.updatedAt;

      d.update(schema.project).set(sets).where(eq(schema.project.projectId, projectId)).run();

      return this.getProject(projectId);
    },

    deleteProject(projectId: string): boolean {
      const rows = d
        .delete(schema.project)
        .where(eq(schema.project.projectId, projectId))
        .returning()
        .all();
      return rows.length > 0;
    },
  };
}

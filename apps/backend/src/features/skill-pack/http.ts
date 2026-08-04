import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSkillIndex } from "@my-agent-team/plugin-progressive-skill";
import { Elysia, t } from "elysia";
import type { SkillPackRow } from "./entities.js";
import { installPath, posixSkillRoot } from "./entities.js";
import { nodeFsAdapter } from "./fs-adapter.js";
import type { SkillPackService } from "./service.js";
import { BuiltinPackImmutableError } from "./service.js";
import { assertSafeEntry } from "./tools.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────────

function toPackResponse(row: SkillPackRow) {
  return {
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
  };
}

// ─── Elysia plugin ────────────────────────────────────────────────────────────────

export function skillPackRoutes(svc: SkillPackService, dataDir: string) {
  const listAll = async () => {
    const rows = await svc.port.list();
    return rows.map(toPackResponse);
  };

  return new Elysia()
    .get("/api/skill-packs", listAll)

    .post(
      "/api/skill-packs/git",
      async ({ body, set }) => {
        const row = await svc.installFromGit({
          name: body.name,
          description: body.description,
          url: body.url,
          ref: body.ref,
        });
        set.status = 202;
        return toPackResponse(row);
      },
      {
        body: t.Object({
          name: t.String(),
          description: t.String(),
          url: t.String(),
          ref: t.Optional(t.String()),
        }),
      },
    )

    .post(
      "/api/skill-packs/upload",
      async ({ body, set }) => {
        const file = body.file;
        const buffer = Buffer.from(await file.arrayBuffer());
        const row = await svc.installFromZip({
          name: body.name,
          description: body.description,
          buffer,
        });
        set.status = 202;
        return toPackResponse(row);
      },
      {
        body: t.Object({
          name: t.String(),
          description: t.String(),
          file: t.File(),
        }),
      },
    )

    .post("/api/skill-packs/:id/sync", async ({ params: { id }, set }) => {
      try {
        const row = await svc.syncGit(id);
        set.status = 202;
        return toPackResponse(row);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    })

    .delete("/api/skill-packs/:id", async ({ params: { id }, set }) => {
      try {
        await svc.uninstall(id);
        const dir = installPath(dataDir, id);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        set.status = 204;
        return "";
      } catch (err) {
        if (err instanceof BuiltinPackImmutableError) {
          set.status = 409;
          return { error: err.message };
        }
        set.status = 404;
        return { error: (err as Error).message };
      }
    })

    .get("/api/skill-packs/:id/skills", async ({ params: { id } }) => {
      const skills = buildSkillIndex([join(posixSkillRoot(dataDir), id)]);
      return skills.map((s) => ({
        name: s.name,
        description: s.description,
        dir: s.relativePath,
      }));
    })

    .get(
      "/api/skill-packs/:id/files",
      async ({ params: { id }, query: { path: subpath } }) => {
        try {
          const ws = nodeFsAdapter(posixSkillRoot(dataDir));
          const basePath = subpath ? `${id}/${subpath}` : id;

          // Validate against traversal
          const segments = subpath ? subpath.split("/") : [];
          for (const seg of segments) assertSafeEntry(seg);

          const st = await ws.stat(basePath);
          if (!st) return { error: "Not found" };

          const full = resolve(posixSkillRoot(dataDir), basePath);
          const s = statSync(full);

          if (s.isFile()) {
            const content = await ws.read(basePath);
            return { type: "file", path: subpath ?? "", content: content ?? "" };
          }

          if (s.isDirectory()) {
            const names = await ws.list(basePath);
            const entries = [];
            for (const name of names) {
              const entryPath = subpath ? `${subpath}/${name}` : name;
              try {
                const entryStat = statSync(resolve(posixSkillRoot(dataDir), id, entryPath));
                entries.push({ name, type: entryStat.isDirectory() ? "dir" : "file" });
              } catch {
                entries.push({ name, type: "file" });
              }
            }
            return { type: "dir", path: subpath ?? "", entries };
          }

          return { error: "Not a file or directory" };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      {
        query: t.Object({
          path: t.Optional(t.String()),
        }),
      },
    );
}

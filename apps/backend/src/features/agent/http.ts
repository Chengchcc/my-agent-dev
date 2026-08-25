import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join as pathJoin, resolve as pathResolve, sep } from "node:path";
import { BACKEND_KINDS } from "@chengchenccc/agent-contract";
import { Elysia, t } from "elysia";
import { probeCliSetupCapability } from "../lark-bot/provisioner.js";
import type { LarkSetupManager } from "../lark-bot/setup-manager.js";
import type { AgentIdentityStore } from "./agent-identity.js";
import type { AgentRow } from "./domain.js";

import type { AgentService } from "./service.js";
import { AgentBusyError, AgentNotFoundError } from "./service.js";

/** Derived from BACKEND_KINDS (single source, e2e-contract-rules): adding
 *  a kind updates the API validator without touching this file. */
const backendKindUnion = t.Enum(
  Object.fromEntries(BACKEND_KINDS.map((k) => [k, k])) as Record<string, string>,
);

/** Bare memory fact filename: no separators, no traversal (memory write API). */
const FACT_FILE_RE = /^[A-Za-z0-9._-]+\.md$/;

// ── Response types (inferred by Elysia from handler return values) ──

function toAgentResponse(row: AgentRow, status: string) {
  const rc = row.config.runtime_config;
  const lk = row.config.lark;
  const slash = rc.model_id.indexOf("/");
  return {
    id: row.id,
    name: row.config.name,
    enabled: row.config.enabled,
    workspacePath: row.workspacePath,
    modelProvider: slash > 0 ? rc.model_id.slice(0, slash) : "unknown",
    modelName: slash > 0 ? rc.model_id.slice(slash + 1) : rc.model_id,
    backendKind: rc.runtime,
    reasoningEffort: rc.reasoning_effort !== "" ? rc.reasoning_effort : null,
    permissionMode: rc.permission_mode,
    maxSteps: rc.max_steps > 0 ? rc.max_steps : null,
    mcpServers: rc.mcp_servers.map((s) => ({ serverId: s.server_id, enabled: s.enabled })),
    knowledgePacks: rc.knowledge_packs,
    projects: rc.projects,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    lark: {
      enabled: lk.enabled,
      appId: lk.app_id !== "" ? lk.app_id : null,
      profileRef: lk.profile_ref !== "" ? lk.profile_ref : null,
      botDisplayName: lk.bot_display_name !== "" ? lk.bot_display_name : null,
      status,
    },
  };
}

function deriveLarkStatus(row: AgentRow, registryStatus?: string): string {
  if (!row.config.lark.enabled || !row.config.lark.profile_ref) return "not_configured";
  if (registryStatus === "running") return "running";
  if (registryStatus === "degraded") return "degraded";
  if (registryStatus === "error") return "error";
  return "configured";
}

// ── Elysia plugin ──
/** Resolve `rel` inside `root`; null when the result escapes the root.
 *  Read-only workspace browsing (the workspace viewer tab). */
function resolveInWorkspace(root: string, rel: string): string | null {
  const abs = rel ? pathResolve(root, rel) : root;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return abs === root || abs.startsWith(prefix) ? abs : null;
}

function realpathSyncSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function agentRoutes(
  svc: AgentService,
  skillPackSvc: {
    listForAgent: (agentId: string) => Promise<{ id: string; name: string; status: string }[]>;
    setAgentPacks: (agentId: string, packIds: string[]) => Promise<void>;
  },
  identityStore?: AgentIdentityStore,
  larkStatusOf?: (agentId: string) => string,
  getSetupManager?: () => LarkSetupManager,
  /** Project existence check for the PATCH projects validation. */
  projectExists?: (id: string) => boolean,
) {
  const statusOf = (row: AgentRow) => deriveLarkStatus(row, larkStatusOf?.(row.id));

  const base = new Elysia()
    .get("/api/agents", async () => {
      const rows = await svc.list();
      return rows.map((row) => toAgentResponse(row, statusOf(row)));
    })
    .post(
      "/api/agents",
      async ({ body, set }) => {
        const row = await svc.create(body);
        set.status = 201;
        return toAgentResponse(row, statusOf(row));
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          template: t.Optional(t.String()),
          model: t.Object({
            provider: t.String({ minLength: 1 }),
            model: t.String({ minLength: 1 }),
          }),
          backendKind: t.Optional(backendKindUnion),
          enabled: t.Optional(t.Boolean()),
          workspacePath: t.Optional(t.String({ minLength: 1 })),
          reasoningEffort: t.Optional(
            t.Union([
              t.Literal("none"),
              t.Literal("low"),
              t.Literal("high"),
              t.Literal("max"),
              t.Null(),
            ]),
          ),
          permissionMode: t.Optional(
            t.Union([t.Literal("ask"), t.Literal("auto"), t.Literal("deny")]),
          ),
          maxSteps: t.Optional(t.Integer({ minimum: 1 })),
          lark: t.Optional(
            t.Object({
              enabled: t.Boolean(),
              appId: t.Optional(t.String({ minLength: 1 })),
              appSecret: t.Optional(t.String({ minLength: 1 })),
              botDisplayName: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .get("/api/agents/:id", async ({ params: { id } }) => {
      try {
        const row = await svc.getById(id);
        return toAgentResponse(row, statusOf(row));
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    })
    .patch(
      "/api/agents/:id",
      async ({ params: { id }, body }) => {
        try {
          if (body.lark?.enabled === true) {
            const existing = await svc.getById(id);
            const hasExistingProfile = !!existing.config.lark.profile_ref;
            const hasFreshCredentials = !!(body.lark?.appId && body.lark?.appSecret);
            if (!hasExistingProfile && !hasFreshCredentials) {
              return Response.json(
                {
                  error:
                    "lark.enabled=true requires appId+appSecret when no existing profile exists",
                },
                { status: 400 },
              );
            }
          }
          if (body.projects && projectExists) {
            for (const pid of body.projects) {
              if (!projectExists(pid)) {
                return Response.json({ error: `unknown project ${pid}` }, { status: 400 });
              }
            }
          }
          const row = await svc.update(id, body);
          return toAgentResponse(row, statusOf(row));
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1 })),
          model: t.Optional(
            t.Object({
              provider: t.String({ minLength: 1 }),
              model: t.String({ minLength: 1 }),
            }),
          ),
          backendKind: t.Optional(backendKindUnion),
          enabled: t.Optional(t.Boolean()),
          workspacePath: t.Optional(t.String({ minLength: 1 })),
          reasoningEffort: t.Optional(
            t.Union([
              t.Literal("none"),
              t.Literal("low"),
              t.Literal("high"),
              t.Literal("max"),
              t.Null(),
            ]),
          ),
          permissionMode: t.Optional(
            t.Union([t.Literal("ask"), t.Literal("auto"), t.Literal("deny")]),
          ),
          maxSteps: t.Optional(t.Integer({ minimum: 1 })),
          mcpServers: t.Optional(
            t.Array(t.Object({ serverId: t.String({ minLength: 1 }), enabled: t.Boolean() })),
          ),
          knowledgePacks: t.Optional(t.Array(t.String({ minLength: 1 }))),
          projects: t.Optional(t.Array(t.String({ minLength: 1 }))),
          lark: t.Optional(
            t.Object({
              enabled: t.Optional(t.Boolean()),
              appId: t.Optional(t.String({ minLength: 1 })),
              appSecret: t.Optional(t.String({ minLength: 1 })),
              botDisplayName: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .delete("/api/agents/:id", async ({ params: { id }, query }) => {
      try {
        if (query.hard === "true") {
          await svc.hardDelete(id);
          return { deleted: true, id };
        }
        return svc.archive(id);
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        if (err instanceof AgentBusyError)
          return Response.json({ error: err.message }, { status: 409 });
        throw err;
      }
    })
    // Identity
    .get("/api/agents/:id/identity", async ({ params: { id } }) => {
      if (!identityStore) return { soul: null, user: null, memories: [] };
      try {
        return identityStore.getIdentity(id);
      } catch (err) {
        if (err instanceof AgentNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    })
    .get("/api/agents/:id/memory", async ({ params: { id } }) => {
      let root: string;
      try {
        root = (await svc.getById(id)).workspacePath;
      } catch {
        return { memories: [], memSummary: null, memoryMd: null };
      }
      const memDir = pathJoin(root, "memory");
      const factsDir = pathJoin(memDir, "facts");
      const factFiles = existsSync(factsDir)
        ? readdirSync(factsDir).filter((f) => f.endsWith(".md"))
        : [];
      const facts = factFiles.map((f) => ({
        file: f,
        content: readFileSync(pathJoin(factsDir, f), "utf-8").slice(0, 2000),
      }));
      const summaryPath = pathJoin(memDir, "memory_summary.md");
      const mdPath = pathJoin(memDir, "MEMORY.md");
      return {
        memories: facts,
        memSummary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : null,
        memoryMd: existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : null,
      };
    })
    .post(
      "/api/agents/:id/memory",
      async ({ params: { id }, body }) => {
        let root: string;
        try {
          root = (await svc.getById(id)).workspacePath;
        } catch {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const memDir = pathJoin(root, "memory");
        mkdirSync(memDir, { recursive: true });
        if (typeof body.memSummary === "string") {
          writeFileSync(pathJoin(memDir, "memory_summary.md"), body.memSummary, "utf-8");
        }
        if (typeof body.memoryMd === "string") {
          writeFileSync(pathJoin(memDir, "MEMORY.md"), body.memoryMd, "utf-8");
        }
        const factsDir = pathJoin(memDir, "facts");
        if (body.facts) {
          mkdirSync(factsDir, { recursive: true });
          for (const f of body.facts) {
            if (!FACT_FILE_RE.test(f.file))
              return Response.json({ error: `invalid fact file: ${f.file}` }, { status: 400 });
            writeFileSync(pathJoin(factsDir, f.file), f.content, "utf-8");
          }
        }
        if (body.deleteFacts) {
          for (const file of body.deleteFacts) {
            if (!FACT_FILE_RE.test(file))
              return Response.json({ error: `invalid fact file: ${file}` }, { status: 400 });
            rmSync(pathJoin(factsDir, file), { force: true });
          }
        }
        return { ok: true };
      },
      {
        body: t.Object({
          memSummary: t.Optional(t.String()),
          memoryMd: t.Optional(t.String()),
          facts: t.Optional(t.Array(t.Object({ file: t.String(), content: t.String() }))),
          deleteFacts: t.Optional(t.Array(t.String())),
        }),
      },
    )
    .get(
      "/api/agents/:id/workspace/entries",
      async ({ params: { id }, query }) => {
        const rel = typeof query?.path === "string" ? query.path : "";
        let root: string;
        try {
          root = (await svc.getById(id)).workspacePath;
        } catch {
          return { path: rel, entries: [] };
        }
        // Realpath the root FIRST: a symlinked workspace root (macOS /tmp)
        // must not turn every legal file into a 403 via a stale prefix.
        const realRoot = realpathSyncSafe(root);
        if (realRoot === null) return { path: rel, entries: [] };
        const target = resolveInWorkspace(realRoot, rel);
        if (target === null)
          return Response.json({ error: "path escapes workspace" }, { status: 403 });
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          return Response.json({ error: "not a directory" }, { status: 400 });
        }
        const entries = readdirSync(target, { withFileTypes: true })
          .map((d) => ({
            name: d.name,
            kind: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file",
            size: d.isFile() ? statSync(pathJoin(target, d.name)).size : null,
          }))
          .sort((a, b) =>
            a.kind === b.kind
              ? a.name.localeCompare(b.name)
              : a.kind === "dir"
                ? -1
                : b.kind === "dir"
                  ? 1
                  : 0,
          );
        return { path: rel, entries };
      },
      {
        query: t.Object({ path: t.Optional(t.String()) }),
      },
    )
    .get(
      "/api/agents/:id/workspace/file",
      async ({ params: { id }, query }) => {
        const rel = typeof query?.path === "string" ? query.path : "";
        if (!rel) return Response.json({ error: "path required" }, { status: 400 });
        let root: string;
        try {
          root = (await svc.getById(id)).workspacePath;
        } catch {
          return Response.json({ error: "agent not found" }, { status: 404 });
        }
        // Realpath the root FIRST (macOS /tmp symlink): the containment
        // check must run against the REAL root, not the lexical path.
        const realRoot = realpathSyncSafe(root);
        if (realRoot === null) return Response.json({ error: "agent not found" }, { status: 404 });
        const target = resolveInWorkspace(realRoot, rel);
        if (target === null)
          return Response.json({ error: "path escapes workspace" }, { status: 403 });
        // realpath: a symlink inside the workspace must not smuggle reads
        // outside it (the bridge links pack dirs; those stay inside).
        const real = realpathSyncSafe(target);
        if (real === null || real === realRoot || !real.startsWith(`${realRoot}${sep}`)) {
          return Response.json({ error: "path escapes workspace" }, { status: 403 });
        }
        if (!existsSync(real) || !statSync(real).isFile()) {
          return Response.json({ error: "not a file" }, { status: 400 });
        }
        const size = statSync(real).size;
        const MAX = 256_000;
        if (size > MAX) return { content: null, size, truncated: true };
        return { content: readFileSync(real, "utf-8"), size, truncated: false };
      },
      {
        query: t.Object({ path: t.String() }),
      },
    )
    .put(
      "/api/agents/:id/identity",
      async ({ params: { id }, body }) => {
        if (!identityStore)
          return Response.json({ error: "Identity store not available" }, { status: 501 });
        try {
          await identityStore.updateIdentity(id, {
            soul: typeof body.soul === "string" ? body.soul : undefined,
            user: typeof body.user === "string" ? body.user : undefined,
          });
          return { ok: true };
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          soul: t.Optional(t.String()),
          user: t.Optional(t.String()),
        }),
      },
    )
    // Lark setup
    .post(
      "/api/agents/:id/lark/setup",
      async ({ params: { id }, body }) => {
        const m = getSetupManager?.();
        if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
        // Fail fast when lark-cli is missing/disabled: a pending session
        // would otherwise hang until the 10-minute timeout.
        if (!(await probeCliSetupCapability())) {
          return Response.json(
            {
              error:
                "Lark CLI setup unavailable: lark-cli not found or disabled in this environment",
            },
            { status: 501 },
          );
        }
        try {
          const existing = await svc.getById(id);
          const pending = m.getByAgentId(id);
          if (pending && pending.status === "pending") return pending;
          const session = await m.create({
            agentId: id,
            botDisplayName:
              typeof body.botDisplayName === "string"
                ? body.botDisplayName
                : existing.config.lark.bot_display_name || undefined,
            brand: body.brand === "lark" ? "lark" : "feishu",
          });
          return session;
        } catch (err) {
          if (err instanceof AgentNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          throw err;
        }
      },
      {
        body: t.Object({
          botDisplayName: t.Optional(t.String()),
          brand: t.Optional(t.Union([t.Literal("feishu"), t.Literal("lark")])),
        }),
      },
    )
    .get("/api/agents/:id/lark/setup/:setupId", ({ params: { id, setupId } }) => {
      const m = getSetupManager?.();
      if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
      const session = m.get(setupId);
      if (!session || session.agentId !== id)
        return Response.json({ error: "Not found" }, { status: 404 });
      return session;
    })
    .delete("/api/agents/:id/lark/setup/:setupId", ({ params: { id, setupId } }) => {
      const m = getSetupManager?.();
      if (!m) return Response.json({ error: "Lark setup not available" }, { status: 501 });
      const session = m.get(setupId);
      if (!session || session.agentId !== id)
        return Response.json({ error: "Not found" }, { status: 404 });
      m.cancel(setupId);
      return { cancelled: true };
    });

  // Skill pack assignment routes (optional)
  const chain = base

    .get("/api/agents/:id/skill-packs", async ({ params: { id } }) => {
      const packs = await skillPackSvc.listForAgent(id);
      return packs;
    })
    .put(
      "/api/agents/:id/skill-packs",
      async ({ params: { id }, body }) => {
        await skillPackSvc.setAgentPacks(id, body.packIds);
        return { ok: true };
      },
      {
        body: t.Object({
          packIds: t.Array(t.String()),
        }),
      },
    );

  return chain;
}

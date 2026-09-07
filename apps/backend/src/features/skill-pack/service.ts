import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../../infra/domain-errors.js";
import type { SkillPackRow, SkillPackSource } from "./entities.js";
import { UpstreamChangedError } from "./install-session.js";
import type { SkillPackPort } from "./ports.js";

export { UpstreamChangedError };

// ─── Service ─────────────────────────────────────────────────────────────────────

export class BuiltinPackImmutableError extends ValidationError {
  constructor() {
    super("Cannot uninstall the builtin skill pack");
  }
}

export interface SkillPackServiceDeps {
  port: SkillPackPort;
  idGen: () => string;
  /** Trigger an installation session. Called async after registering the pack record. */
  triggerInstall: (packId: string, ctx: InstallSessionCtx) => void;
  /** Trigger a sync session. */
  triggerSync: (packId: string, ctx: InstallSessionCtx) => void;
  /** Read-only upstream check before a sync (returns the change, or null). */
  checkSync?: (
    packId: string,
    ctx: InstallSessionCtx,
  ) => Promise<{ from: string | null; to: string } | null>;
}

export interface InstallSessionCtx {
  packId: string;
  sourceKind: SkillPackSource;
  sourceUrl: string | null;
  versionRef: string | null;
  expectedRev?: string | null;
}

export function createSkillPackService(deps: SkillPackServiceDeps) {
  const { port, idGen, triggerInstall, triggerSync } = deps;

  return {
    port,
    // ─── Install ──────────────────────────────────────────────────────

    async installFromGit(input: {
      name: string;
      description: string;
      url: string;
      ref?: string;
      keepSynced?: boolean;
    }): Promise<SkillPackRow> {
      const id = idGen();
      const now = Date.now();
      const row = await port.register({
        id,
        name: input.name,
        description: input.description,
        sourceKind: "git",
        sourceUrl: input.url,
        versionRef: input.ref ?? null,
        keepSynced: input.keepSynced ?? false,
        now,
      });

      const ctx: InstallSessionCtx = {
        packId: id,
        sourceKind: "git",
        sourceUrl: input.url,
        versionRef: input.ref ?? null,
      };
      triggerInstall(id, ctx);

      return row;
    },

    async installFromZip(input: {
      name: string;
      description: string;
      buffer: Buffer;
    }): Promise<SkillPackRow> {
      const id = idGen();
      const now = Date.now();
      const row = await port.register({
        id,
        name: input.name,
        description: input.description,
        sourceKind: "zip",
        sourceUrl: null,
        versionRef: null,
        now,
      });

      // Encode buffer as base64 for the install session
      const ctx: InstallSessionCtx = {
        packId: id,
        sourceKind: "zip",
        sourceUrl: input.buffer.toString("base64"),
        versionRef: null,
      };
      triggerInstall(id, ctx);

      return row;
    },

    // ─── Sync ─────────────────────────────────────────────────────────

    async syncGit(packId: string, confirm = false): Promise<SkillPackRow> {
      const row = await port.get(packId);
      if (!row) throw new Error(`Pack not found: ${packId}`);
      if (row.sourceKind !== "git") throw new Error(`Cannot sync non-git pack: ${packId}`);

      const ctx: InstallSessionCtx = {
        packId: row.id,
        sourceKind: row.sourceKind,
        sourceUrl: row.sourceUrl,
        versionRef: row.versionRef,
      };

      if (!confirm && deps.checkSync) {
        const upstream = await deps.checkSync(packId, ctx);
        if (upstream) throw new UpstreamChangedError(upstream.from, upstream.to);
      }
      if (confirm) {
        // Close the confirm TOCTOU: re-check upstream NOW and pin the sync to
        // exactly this rev — runSync refuses to reset if FETCH_HEAD moved.
        const upstream = deps.checkSync ? await deps.checkSync(packId, ctx) : null;
        ctx.expectedRev = upstream ? upstream.to : row.installedRef;
      }

      const updated = await port.applyInstallTransition(packId, "syncing", { now: Date.now() });
      if (!updated) throw new Error(`Failed to transition pack ${packId} to syncing`);
      triggerSync(packId, ctx);

      return updated;
    },

    // ─── Uninstall ────────────────────────────────────────────────────

    /** Deterministic export of the installed pack state (skills-lock.json body). */
    async lockfile(): Promise<{
      generatedAt: number;
      packs: Array<{
        id: string;
        name: string;
        sourceKind: string;
        sourceUrl: string | null;
        installedRef: string | null;
        status: string;
        keepSynced: boolean;
      }>;
    }> {
      const packs = await port.list();
      return {
        generatedAt: Date.now(),
        packs: packs.map((p) => ({
          id: p.id,
          name: p.name,
          sourceKind: p.sourceKind,
          sourceUrl: p.sourceUrl,
          installedRef: p.installedRef,
          status: p.status,
          keepSynced: p.keepSynced === true,
        })),
      };
    },

    /** Per-pack integrity check: materialized dir present, SKILL.md files
     *  discoverable, frontmatter name present. Read-only. */
    async validate(): Promise<
      Array<{ id: string; name: string; ok: boolean; skills: number; issues: string[] }>
    > {
      const packs = await port.list();
      return packs.map((p) => {
        const issues: string[] = [];
        let skills = 0;
        const root = p.installedRef;
        if (!root || !existsSync(root)) {
          issues.push("materialized directory missing");
          return { id: p.id, name: p.name, ok: false, skills, issues };
        }
        const scan = (dir: string, depth: number) => {
          if (depth > 6) return;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              scan(full, depth + 1);
              continue;
            }
            if (entry.name === "SKILL.md") {
              try {
                const head = readFileSync(full, "utf8").slice(0, 600);
                if (/^---[\s\S]*name:/.test(head)) skills += 1;
                else
                  issues.push(`SKILL.md missing frontmatter name: ${full.slice(root.length + 1)}`);
              } catch {
                issues.push(`SKILL.md unreadable: ${full.slice(root.length + 1)}`);
              }
            }
          }
        };
        scan(root, 0);
        if (skills === 0) issues.push("no SKILL.md found");
        return { id: p.id, name: p.name, ok: issues.length === 0, skills, issues };
      });
    },

    async uninstall(packId: string): Promise<void> {
      const row = await port.get(packId);
      if (!row) throw new Error(`Pack not found: ${packId}`);
      if (row.sourceKind === "builtin") {
        throw new BuiltinPackImmutableError();
      }

      // Cascade: clear agent assignments first, then remove the pack record
      await port.removeAgentPack(packId);
      // The caller (HTTP handler) is responsible for deleting the directory
      await port.remove(packId);
    },

    // ─── Agent assignments ────────────────────────────────────────────

    async listForAgent(agentId: string): Promise<SkillPackRow[]> {
      return port.listForAgent(agentId);
    },

    async setAgentPacks(agentId: string, packIds: string[]): Promise<void> {
      await port.setAgentPacks(agentId, packIds, Date.now());
    },
  };
}

export type SkillPackService = ReturnType<typeof createSkillPackService>;

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

      const updated = await port.applyInstallTransition(packId, "syncing", { now: Date.now() });
      if (!updated) throw new Error(`Failed to transition pack ${packId} to syncing`);

      triggerSync(packId, ctx);

      return updated;
    },

    // ─── Uninstall ────────────────────────────────────────────────────

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

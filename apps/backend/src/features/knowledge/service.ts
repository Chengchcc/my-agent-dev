import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import type { KnowledgePackRow } from "./entities.js";
import { installKnowledgePack, knowledgeInstallRoot } from "./install.js";
import type { KnowledgePackPort } from "./ports.js";

export class KnowledgePackNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("Knowledge pack", id);
  }
}

export class KnowledgeValidationError extends ValidationError {}

/** Knowledge pack install pool (ADR 0022). Per-agent switches live in
 *  agent.yml — this service owns the pool only. */
export interface KnowledgePackStats {
  packId: string;
  status: string;
  files: number;
  totalBytes: number;
  /** Rough token estimate (bytes/4) — an approximation, not a tokenizer. */
  estTokens: number;
  newestFileAt: number | null;
}

export interface KnowledgeService {
  list(): KnowledgePackRow[];
  stats(packId: string): KnowledgePackStats;
  getById(id: string): KnowledgePackRow | null;
  install(input: {
    name: string;
    description?: string;
    sourceKind: "builtin" | "git" | "zip";
    sourceUrl?: string;
    versionRef?: string;
  }): Promise<KnowledgePackRow>;
  delete(id: string): Promise<void>;
}

export function createKnowledgeService(deps: {
  port: KnowledgePackPort;
  dataDir: string;
  idGen: () => string;
  builtinRoot?: string;
  zipBuffer?: Buffer;
}): KnowledgeService {
  return {
    list(): KnowledgePackRow[] {
      return deps.port.list();
    },

    stats(packId: string): KnowledgePackStats {
      const row = deps.port.getById(packId);
      if (!row) throw new KnowledgePackNotFoundError(packId);
      let files = 0;
      let totalBytes = 0;
      let newestFileAt: number | null = null;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(p);
            continue;
          }
          const st = statSync(p);
          files += 1;
          totalBytes += st.size;
          newestFileAt = newestFileAt == null ? st.mtimeMs : Math.max(newestFileAt, st.mtimeMs);
        }
      };
      try {
        walk(knowledgeInstallRoot(deps.dataDir, packId));
      } catch {
        /* materialized dir missing — zero stats */
      }
      return {
        packId,
        status: row.status,
        files,
        totalBytes,
        estTokens: Math.round(totalBytes / 4),
        newestFileAt,
      };
    },

    getById(id: string): KnowledgePackRow | null {
      return deps.port.getById(id);
    },

    async install(input): Promise<KnowledgePackRow> {
      if (input.sourceKind !== "builtin" && !input.sourceUrl && !deps.zipBuffer) {
        throw new KnowledgeValidationError(
          "sourceUrl required for git packs; zip upload required for zip packs",
        );
      }
      const id = deps.idGen();
      return installKnowledgePack(deps, {
        id,
        name: input.name,
        description: input.description ?? "",
        sourceKind: input.sourceKind,
        sourceUrl: input.sourceUrl ?? null,
        versionRef: input.versionRef ?? null,
      });
    },

    async delete(id: string): Promise<void> {
      const existing = deps.port.getById(id);
      if (!existing) throw new KnowledgePackNotFoundError(id);
      deps.port.delete(id);
      rmSync(knowledgeInstallRoot(deps.dataDir, id), { recursive: true, force: true });
    },
  };
}

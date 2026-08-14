import { rmSync } from "node:fs";
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
export interface KnowledgeService {
  list(): KnowledgePackRow[];
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

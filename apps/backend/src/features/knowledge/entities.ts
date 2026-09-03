/** Knowledge pack entities (ADR 0022): a global install pool; per-agent
 *  switches live in agent.yml (file-first). */

export type KnowledgePackSource = "builtin" | "git" | "zip";
export type KnowledgePackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";

export interface KnowledgePackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: KnowledgePackSource;
  sourceUrl: string | null;
  versionRef: string | null;
  sourceRev: string | null;
  installedRef: string | null;
  status: KnowledgePackStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InstallKnowledgeInput {
  name: string;
  description?: string;
  sourceKind: KnowledgePackSource;
  sourceUrl?: string;
  versionRef?: string;
}

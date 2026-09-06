import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { knowledgePackKeys } from "./query-keys";

export interface KnowledgePackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: "builtin" | "git" | "zip";
  sourceUrl: string | null;
  versionRef: string | null;
  sourceRev: string | null;
  installedRef: string | null;
  status: "pending" | "installing" | "ready" | "failed" | "syncing";
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export function knowledgePacksQuery() {
  return queryOptions({
    queryKey: knowledgePackKeys.all,
    queryFn: () => api.listKnowledgePacks() as Promise<{ packs: KnowledgePackRow[] }>,
  });
}

export function knowledgePackFilesQuery(id: string, path?: string) {
  return queryOptions({
    queryKey: knowledgePackKeys.files(id, path),
    queryFn: () => api.getKnowledgePackFiles(id, path),
    enabled: !!id,
  });
}

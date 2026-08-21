import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { knowledgePackKeys } from "./query-keys";

export interface KnowledgePackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: "builtin" | "git" | "zip";
  status: "pending" | "installing" | "ready" | "failed" | "syncing";
  error: string | null;
}

export function knowledgePacksQuery() {
  return queryOptions({
    queryKey: knowledgePackKeys.all,
    queryFn: () => api.listKnowledgePacks() as Promise<{ packs: KnowledgePackRow[] }>,
  });
}

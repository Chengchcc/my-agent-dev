import { useQuery } from "@tanstack/react-query";
import { knowledgePackFilesQuery, knowledgePacksQuery } from "./queries";

export function useKnowledgePacks() {
  return useQuery(knowledgePacksQuery());
}

export function useKnowledgePackFiles(id: string, path?: string) {
  return useQuery({ ...knowledgePackFilesQuery(id, path), enabled: !!id });
}

export { knowledgePackKeys } from "./query-keys";

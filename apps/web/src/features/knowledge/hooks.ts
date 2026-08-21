import { useQuery } from "@tanstack/react-query";
import { knowledgePacksQuery } from "./queries";

export function useKnowledgePacks() {
  return useQuery(knowledgePacksQuery());
}

export { knowledgePackKeys } from "./query-keys";

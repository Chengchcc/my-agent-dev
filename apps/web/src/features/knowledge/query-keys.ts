export const knowledgePackKeys = {
  all: ["knowledge-packs"] as const,
  files: (id: string, path?: string) => ["knowledge-packs", id, "files", path ?? ""] as const,
};

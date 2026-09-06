"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** A pack file/dir node, shared by skill + knowledge pack browsers. */
export type PackFileNode =
  | { type: "file"; path: string; content: string }
  | { type: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" }> };

export type PackKind = "skill" | "knowledge";

const baseKey = (kind: PackKind) => (kind === "knowledge" ? ["knowledge-packs"] : ["skill-packs"]);

/** One hook for both pack kinds — the same read-only file surface is reused
 *  by the skill-pack and knowledge-pack drawers. */
export function usePackFiles(kind: PackKind, id: string, path?: string) {
  return useQuery({
    queryKey: [...baseKey(kind), id, "files", path ?? ""],
    queryFn: () =>
      (kind === "knowledge"
        ? api.getKnowledgePackFiles(id, path)
        : api.getSkillPackFiles(id, path)) as Promise<PackFileNode>,
    enabled: !!id,
  });
}

export function searchPackFiles(
  kind: PackKind,
  id: string,
  q: string,
): Promise<{ results?: Array<{ path: string; line: number; snippet: string }>; error?: string }> {
  return kind === "knowledge" ? api.searchKnowledgePack(id, q) : api.searchSkillPack(id, q);
}

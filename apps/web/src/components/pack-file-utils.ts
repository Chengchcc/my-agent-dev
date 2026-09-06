"use client";

import { type UseQueryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query";
import { knowledgePackFilesQuery } from "@/features/knowledge/queries";
import { skillPackFilesQuery } from "@/features/skill-packs/queries";
import { api } from "@/lib/api";

/** A pack file/dir node, shared by skill + knowledge pack browsers. */
export type PackFileNode =
  | { type: "file"; path: string; content: string }
  | { type: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" }> };

export type PackKind = "skill" | "knowledge";

/** One hook for both pack kinds — the same read-only file surface is reused
 *  by the skill-pack and knowledge-pack drawers. */
type PackFilesQueryOptions = UseQueryOptions<PackFileNode, Error, PackFileNode, readonly unknown[]>;

/** One hook for both pack kinds — the same read-only file surface is reused
 *  by the skill-pack and knowledge-pack drawers. */
export function usePackFiles(
  kind: PackKind,
  id: string,
  path?: string,
): UseQueryResult<PackFileNode, Error> {
  return useQuery(
    (kind === "knowledge"
      ? knowledgePackFilesQuery(id, path)
      : skillPackFilesQuery(id, path)) as PackFilesQueryOptions,
  );
}

export function searchPackFiles(
  kind: PackKind,
  id: string,
  q: string,
): Promise<{ results?: Array<{ path: string; line: number; snippet: string }>; error?: string }> {
  return kind === "knowledge" ? api.searchKnowledgePack(id, q) : api.searchSkillPack(id, q);
}

"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useSkillPackFiles } from "@/features/skill-packs/hooks";
import { ReadOnlyFileViewer } from "./ReadOnlyFileViewer";

/** Read-only file surface for a skill pack, backed by the shared viewer. */
export function PackFileViewer({ packId, path }: { packId: string; path: string }) {
  const { data, isLoading } = useSkillPackFiles(packId, path);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (data?.type !== "file") return null;

  return <ReadOnlyFileViewer path={data.path ?? path} content={data.content ?? ""} />;
}

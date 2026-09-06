"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { type PackKind, usePackFiles } from "./pack-file-utils";
import { ReadOnlyFileViewer } from "./ReadOnlyFileViewer";

/** Read-only file surface for a skill or knowledge pack, backed by the
 *  shared viewer. */
export function PackFileViewer({
  packId,
  path,
  kind = "skill",
}: {
  packId: string;
  path: string;
  kind?: PackKind;
}) {
  const { data, isLoading } = usePackFiles(kind, packId, path);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (data?.type !== "file") return null;

  return <ReadOnlyFileViewer path={data.path ?? path} content={data.content ?? ""} />;
}

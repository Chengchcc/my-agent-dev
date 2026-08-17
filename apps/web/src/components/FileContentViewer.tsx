"use client";

import { ChevronRight } from "lucide-react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

const MonacoViewer = dynamic(
  () => import("@/components/MonacoViewer").then((m) => m.MonacoViewer),
  {
    ssr: false,
    loading: () => <Skeleton className="h-96 w-full" />,
  },
);

/** Single file-content surface: header + read-only Monaco viewer. */
export function FileContentViewer({
  value,
  path,
  truncated = false,
}: {
  value: string;
  path: string;
  truncated?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[320px] flex-col overflow-hidden rounded-md border border-(--hairline) bg-(--panel)">
      <div className="flex items-center gap-1 border-b border-(--hairline) px-3 py-2 text-xs text-(--mute)">
        <ChevronRight className="size-3 shrink-0" />
        <span className="truncate font-mono">{path}</span>
        {truncated && <span className="shrink-0 text-amber-500">— truncated (256K cap)</span>}
      </div>
      <div className="min-h-0 flex-1">
        <MonacoViewer value={value} path={path} />
      </div>
    </div>
  );
}

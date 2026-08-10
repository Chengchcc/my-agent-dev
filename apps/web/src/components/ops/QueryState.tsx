"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { classifyError } from "@/lib/api";

interface QueryStateProps<T> {
  query: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    data: T | undefined;
  };
  empty?: (data: T) => boolean;
  emptyMessage?: string;
  /** Structured empty state (preferred over the bare emptyMessage). */
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: LucideIcon;
  children: (data: T) => ReactNode;
}

function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-muted rounded w-1/3" />
      <div className="h-3 bg-muted rounded w-2/3" />
      <div className="h-3 bg-muted rounded w-1/2" />
    </div>
  );
}

export function QueryState<T>({
  query,
  empty,
  emptyMessage,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  children,
}: QueryStateProps<T>) {
  if (query.isLoading) {
    return (
      <div className="p-6">
        <Skeleton />
      </div>
    );
  }

  if (query.isError) {
    const kind = classifyError(query.error);
    switch (kind) {
      case "unauthorized":
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">Session expired, redirecting…</p>
          </div>
        );
      case "not_found":
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">Not found</p>
          </div>
        );
      case "backend_unavailable":
        return (
          <div className="p-6 space-y-2">
            <p className="text-muted-foreground text-sm">Backend unavailable</p>
            <Button variant="link" size="sm" onClick={() => (query as UseQueryResult).refetch()}>
              Retry
            </Button>
          </div>
        );
      default:
        return (
          <div className="p-6">
            <p className="text-muted-foreground text-sm">
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </p>
          </div>
        );
    }
  }

  if (query.data !== undefined && empty?.(query.data)) {
    if (emptyTitle) {
      return (
        <EmptyState icon={emptyIcon ?? Inbox} title={emptyTitle} description={emptyDescription} />
      );
    }
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">{emptyMessage ?? "No data available."}</p>
      </div>
    );
  }

  if (query.data === undefined) {
    return (
      <div className="p-6">
        <Skeleton />
      </div>
    );
  }

  return <>{children(query.data)}</>;
}

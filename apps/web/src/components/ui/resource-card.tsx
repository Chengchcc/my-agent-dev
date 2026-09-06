"use client";

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type ResourceTone = "ok" | "warn" | "err" | "info" | "default";

function chipStyle(tone?: ResourceTone): { background: string; color: string } {
  if (!tone || tone === "default") return { background: "var(--panel2)", color: "var(--mute)" };
  return {
    background: `color-mix(in srgb, var(--${tone}) 12%, transparent)`,
    color: `var(--${tone})`,
  };
}

function badgeVariant(tone?: ResourceTone): "default" | "destructive" | "secondary" {
  if (tone === "err") return "destructive";
  if (tone === "ok") return "default";
  return "secondary";
}

/** Small pill used for resource tags / lint chips. */
export function ResourceTag({ label, tone }: { label: string; tone?: ResourceTone }) {
  return (
    <Text as="span" className="rounded px-1.5 py-0.5 text-(--text-cap)" style={chipStyle(tone)}>
      {label}
    </Text>
  );
}

/** Thin headless card shell for resource pools (skills / mcp / knowledge).
 *  Provides only the card chrome + an optional right-edge tone bar. Content is
 *  supplied by the caller via <ResourceCardHeader>/<ResourceCardContent>/
 *  <ResourceCardFooter> children — shadcn-style, no fixed business fields. */
export function ResourceCard({
  tone,
  onClick,
  className,
  children,
}: {
  /** Right-edge accent bar color. "default" (or omitted) renders no bar. */
  tone?: ResourceTone;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const accent = tone;
  return (
    <Card
      size="sm"
      onClick={onClick}
      className={cn(
        "relative h-full overflow-hidden",
        accent && accent !== "default" && "pl-3",
        onClick && "cursor-pointer transition-colors hover:bg-(--panel2)",
        className,
      )}
    >
      {accent && accent !== "default" && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: `var(--${accent})` }}
        />
      )}
      {children}
    </Card>
  );
}

/** Header: icon tile + title + id chip + optional status badge. */
export function ResourceCardHeader({
  icon,
  title,
  idChip,
  badge,
  className,
}: {
  icon?: ReactNode;
  title: string;
  idChip?: string;
  badge?: { label: string; tone?: ResourceTone };
  className?: string;
}) {
  return (
    <CardHeader className={cn("flex items-start justify-between gap-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-(--hairline) bg-(--panel2)">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <CardTitle className="truncate">{title}</CardTitle>
          {idChip && (
            <Text as="p" className="truncate font-mono text-xs text-(--faint)">
              {idChip}
            </Text>
          )}
        </div>
      </div>
      {badge && (
        <Badge variant={badgeVariant(badge.tone)} className="shrink-0">
          {badge.label}
        </Badge>
      )}
    </CardHeader>
  );
}

/** Body: free-form content. */
export function ResourceCardContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <CardContent className={cn("space-y-2", className)}>{children}</CardContent>;
}

/**
 * Uniform footer: left meta/status mono line + right single action button with
 * an arrow, matching the design's "Inspect ⟶" control across all cap cards.
 * `children` (rare extra controls) render after the action.
 */
export function ResourceCardFooter({
  meta,
  action,
  children,
}: {
  meta?: ReactNode;
  action?: { label: string; onClick?: () => void };
  children?: ReactNode;
}) {
  return (
    <CardFooter
      className="flex-wrap items-center justify-between gap-1 border-t bg-transparent p-3"
      onClick={(e) => e.stopPropagation()}
    >
      {meta && <span className="min-w-0 truncate font-mono text-[10px] text-(--mute)">{meta}</span>}
      <span className="flex shrink-0 items-center gap-1">
        {action && (
          <Button variant="outline" size="sm" className="gap-1" onClick={action.onClick}>
            {action.label}
            <ArrowRight className="size-3.5" />
          </Button>
        )}
        {children}
      </span>
    </CardFooter>
  );
}

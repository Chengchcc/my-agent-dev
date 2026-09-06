"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
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

/**
 * Unified small card for team resource pools (skills / mcp / knowledge /
 * projects). Header = icon + title + status badge; body = description +
 * tags/lint + meta line; footer = text action buttons.
 */
export function ResourceCard({
  icon,
  title,
  idChip,
  badge,
  tone,
  description,
  tags,
  lint,
  meta,
  footer,
  onClick,
  className,
}: {
  icon?: ReactNode;
  title: string;
  idChip?: string;
  badge?: { label: string; tone?: ResourceTone };
  /** Right-edge accent bar color. Defaults to the badge tone; pass explicitly
   *  when there's no badge but a status color is wanted (e.g. list cards). */
  tone?: ResourceTone;
  description?: string;
  tags?: Array<{ label: string; tone?: ResourceTone }>;
  lint?: Array<{ label: string; tone?: ResourceTone }>;
  meta?: string;
  footer?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const accent = tone ?? badge?.tone;
  return (
    <Card
      size="sm"
      onClick={onClick}
      className={cn(
        "relative h-full",
        accent && accent !== "default" && "pr-3",
        onClick && "cursor-pointer transition-colors hover:bg-(--panel2)",
        className,
      )}
    >
      {accent && accent !== "default" && (
        <span
          aria-hidden
          className="absolute inset-y-0 right-0 w-1"
          style={{ background: `var(--${accent})` }}
        />
      )}
      <CardHeader className="flex items-start justify-between gap-2">
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
      <CardContent className="space-y-2">
        {description && (
          <Text as="p" className="line-clamp-2 text-sm text-(--mute)">
            {description}
          </Text>
        )}
        {(tags?.length || lint?.length) && (
          <div className="flex flex-wrap items-center gap-1">
            {tags?.map((t) => (
              <ResourceTag key={`t-${t.label}`} {...t} />
            ))}
            {lint?.map((t) => (
              <ResourceTag key={`l-${t.label}`} {...t} />
            ))}
          </div>
        )}
        {meta && (
          <Text as="p" className="text-xs text-(--mute)">
            {meta}
          </Text>
        )}
      </CardContent>
      {footer && (
        <CardFooter
          className="flex-wrap justify-start gap-1 border-t bg-transparent p-3"
          onClick={(e) => e.stopPropagation()}
        >
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}

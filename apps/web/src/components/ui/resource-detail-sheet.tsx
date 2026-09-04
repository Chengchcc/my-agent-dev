"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubTabs } from "@/components/ui/polish";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import type { ResourceTone } from "./resource-card";

function badgeVariant(tone?: ResourceTone): "default" | "destructive" | "secondary" {
  if (tone === "err") return "destructive";
  if (tone === "ok") return "default";
  return "secondary";
}

/**
 * Shared right-side detail drawer for team resource pools. Handles the
 * sheet chrome + optional tab bar; pages only supply the active tab body
 * and footer actions.
 */
export function ResourceDetailSheet({
  open,
  onClose,
  icon,
  title,
  subtitle,
  badge,
  tabs,
  tab,
  onTabChange,
  breadcrumb,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  badge?: { label: string; tone?: ResourceTone };
  tabs?: Array<{ key: string; label: string }>;
  tab?: string;
  onTabChange?: (key: string) => void;
  /** Drilled-down navigation: e.g. [Pack, Skill] or [Server, Capabilities]. */
  breadcrumb?: Array<{ label: string; onClick?: () => void }>;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[92vw] max-w-[1100px] overflow-y-auto">
        <SheetHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {icon && (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-(--hairline) bg-(--panel2)">
                  {icon}
                </div>
              )}
              <div className="min-w-0">
                <SheetTitle className="truncate">{title}</SheetTitle>
                {subtitle && <SheetDescription className="truncate">{subtitle}</SheetDescription>}
              </div>
            </div>
            {badge && (
              <Badge variant={badgeVariant(badge.tone)} className="shrink-0">
                {badge.label}
              </Badge>
            )}
          </div>
        </SheetHeader>

        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="mt-2 flex flex-wrap items-center gap-1 text-xs text-(--mute)">
            {breadcrumb.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && (
                  <Text as="span" className="text-(--faint)">
                    ›
                  </Text>
                )}
                {c.onClick ? (
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-(--mute) hover:text-(--ink)"
                    onClick={c.onClick}
                  >
                    {c.label}
                  </Button>
                ) : (
                  <Text as="span" className="text-(--ink)">
                    {c.label}
                  </Text>
                )}
              </span>
            ))}
          </nav>
        )}

        {tabs && tabs.length > 0 && (
          <div className="mt-2 border-b border-(--hairline)">
            <SubTabs items={tabs} active={tab ?? ""} onChange={(k) => onTabChange?.(k)} />
          </div>
        )}

        <div className="mt-4 min-h-0 flex-1">{children}</div>

        {footer && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-(--hairline) pt-3">
            {footer}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

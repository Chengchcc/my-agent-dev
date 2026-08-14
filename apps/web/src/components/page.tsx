import type { ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

/** Shared page skeleton. One grammar for every top-level page:
 *  PageHeader (border-bottom, title/description/action) + PageBody
 *  (responsive padding; wide = max-w-7xl, reading = max-w-3xl). */
export function Page({ children }: { children: ReactNode }) {
  return <div className="min-h-full">{children}</div>;
}

export function PageHeader({
  breadcrumb,
  title,
  kicker,
  subtitle,
  description,
  action,
  actions,
}: {
  breadcrumb?: string;
  title: string;
  kicker?: string;
  subtitle?: string;
  /** Legacy single action (kept for existing callers). */
  description?: string;
  action?: ReactNode;
  /** Action cluster, right-aligned: ghost -> outline -> primary, gap 8. */
  actions?: ReactNode;
}) {
  return (
    <div className="border-b border-(--hairline) p-4 sm:px-6 lg:px-8 ">
      {breadcrumb && (
        <Breadcrumb className="mb-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>{breadcrumb}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {kicker && (
            <p className="text-(--text-cap) tracking-kicker uppercase font-semibold text-(--mute)">
              {kicker}
            </p>
          )}
          <h1 className="text-[1.625rem] font-semibold leading-tight text-(--ink)">{title}</h1>
          {(subtitle ?? description) && (
            <p className="mt-0.5 text-(--text-body) text-(--mute)">{subtitle ?? description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">{actions ?? action}</div>
      </div>
    </div>
  );
}

export function PageBody({
  size = "wide",
  className,
  children,
}: {
  size?: "wide" | "reading";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "px-4 sm:px-6 lg:p-8 py-6 ",
        size === "wide" ? "mx-auto max-w-7xl" : "mx-auto max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

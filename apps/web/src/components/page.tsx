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
  return <div className="h-full">{children}</div>;
}

export function PageHeader({
  breadcrumb,
  title,
  description,
  action,
}: {
  breadcrumb?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-b border-[var(--hairline)] px-4 sm:px-6 lg:px-8 py-4">
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
          <h1 className="text-xl font-semibold text-[var(--ink)]">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
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
        "px-4 sm:px-6 lg:px-8 py-6 lg:py-8",
        size === "wide" ? "mx-auto max-w-7xl" : "mx-auto max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

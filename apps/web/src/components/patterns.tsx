import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ── Obsidian Control Matrix page patterns ──
 * Shared building blocks for the redesign: every page (designed or deep)
 * composes from this kit so density and language stay consistent. */

/** Uppercase JetBrains micro-label — `STATUS: RUNNING` style. */
export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold uppercase tracking-kicker text-(--mute)",
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONES = ["running", "success", "waiting", "error", "idle"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

const STATUS_STYLE: Record<StatusTone, { dot: string; text: string }> = {
  running: { dot: "bg-(--primary) animate-dot-pulse", text: "text-(--primary)" },
  success: { dot: "bg-(--ok)", text: "text-(--ok)" },
  waiting: { dot: "bg-(--accent-violet)", text: "text-(--accent-violet)" },
  error: { dot: "bg-(--err)", text: "text-(--err)" },
  idle: { dot: "bg-(--faint)", text: "text-(--mute)" },
};

/** Execution status pill: tone dot + uppercase mono label. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  const style = STATUS_STYLE[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-kicker",
        style.text,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {children}
    </span>
  );
}

/** Breadcrumb + display title + optional pill + right-aligned actions. */
export function PageHeader({
  breadcrumb,
  title,
  pill,
  actions,
  className,
}: {
  breadcrumb: ReactNode;
  title: ReactNode;
  pill?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <MonoLabel className="text-(--faint)">{breadcrumb}</MonoLabel>
        <div className="mt-1 flex items-center gap-2.5">
          <h1 className="truncate font-display text-h1 font-semibold tracking-tight text-(--ink-strong)">
            {title}
          </h1>
          {pill}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Compact metric tile: micro-label, oversized tabular value, detail, bar. */
export function KpiTile({
  label,
  value,
  detail,
  icon: Icon,
  bar,
  barTone = "primary",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  /** 0–100 fill width for the progress strip. */
  bar?: number;
  barTone?: "primary" | "ok" | "violet";
  className?: string;
}) {
  const BAR_COLOR: Record<string, string> = {
    primary: "bg-(--primary)",
    ok: "bg-(--ok)",
    violet: "bg-(--accent-violet)",
  };
  return (
    <div
      className={cn(
        "relative flex flex-col gap-1 rounded-lg border border-(--hairline) bg-(--panel) p-3",
        className,
      )}
    >
      {Icon && <Icon className="absolute top-3 right-3 size-4 text-(--faint)" />}
      <MonoLabel>{label}</MonoLabel>
      <span className="font-display text-[28px] font-semibold tracking-tight text-(--ink-strong) tabular-nums">
        {value}
      </span>
      {detail && <span className="text-xs text-(--mute)">{detail}</span>}
      {typeof bar === "number" && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-(--panel2)">
          <div
            className={cn("h-full rounded-full", BAR_COLOR[barTone])}
            style={{ width: `${Math.min(100, Math.max(0, bar))}%` }}
          />
        </div>
      )}
    </div>
  );
}

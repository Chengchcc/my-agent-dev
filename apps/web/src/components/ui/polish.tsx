"use client";

import type { ReactNode } from "react";
import { useState } from "react";

/** Page-level secondary tab bar (below PageHeader): active = ink text +
 *  2px ok underline; inactive = mute. 40px click area. */
export function SubTabs({
  items,
  active,
  onChange,
}: {
  items: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-(--hairline)" role="tablist">
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={isActive}
            type="button"
            onClick={() => onChange(item.key)}
            className={`relative h-10 px-3 text-(--text-body) transition-colors ${
              isActive ? "text-(--ink)" : "text-(--mute) hover:text-(--ink)"
            }`}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="ml-1.5 text-(--text-cap) text-(--faint)">{item.count}</span>
            )}
            {isActive && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-(--ok)" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Closable info banner ("how this page works"). Persists via
 *  localStorage key `ib:<id>`. */
export function InfoBanner({ id, title, body }: { id: string; title: string; body: string }) {
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(`ib:${id}`) === "1";
    } catch {
      return false;
    }
  });
  if (closed) return null;
  const dismiss = () => {
    setClosed(true);
    try {
      localStorage.setItem(`ib:${id}`, "1");
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{
        background: "color-mix(in srgb, var(--info) 8%, transparent)",
        borderColor: "color-mix(in srgb, var(--info) 30%, transparent)",
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-(--text-body) font-medium text-(--ink)">{title}</p>
          <p className="mt-0.5 text-(--text-body) text-(--mute)">{body}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="ml-auto shrink-0 text-(--mute) hover:text-(--ink)"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** Metric card: cap label + h2 value; tone only when out of bounds. */
export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "info" | "warn" | "err";
}) {
  const toneColor =
    tone === "warn"
      ? "var(--warn)"
      : tone === "err"
        ? "var(--err)"
        : tone === "info"
          ? "var(--info)"
          : "var(--ink)";
  return (
    <div className="rounded-(--radius-card) border border-(--hairline) bg-(--panel) px-4 py-3">
      <p className="text-(--text-cap) uppercase tracking-kicker text-(--mute)">{label}</p>
      <p className="mt-1 text-(--text-h2) font-semibold" style={{ color: toneColor }}>
        {value}
      </p>
    </div>
  );
}

/** The single list-row shape: icon block + title(+subtitle) + tag + idChip
 *  + desc/meta + status + actions/secondaryActions. */
export function ListRowCard({
  icon,
  title,
  subtitle,
  tag,
  badges,
  idChip,
  desc,
  meta,
  status,
  actions,
  secondaryActions,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  tag?: { label: string; tone?: "info" | "warn" | "err" };
  badges?: Array<string | { label: string; tone?: "ok" | "warn" | "err" }>;
  idChip?: string;
  desc?: string;
  meta?: string[];
  status?: "ok" | "warn" | "err" | "idle";
  actions?: ReactNode;
  secondaryActions?: ReactNode;
  onClick?: () => void;
}) {
  const statusDot =
    status === "ok"
      ? "var(--ok)"
      : status === "warn"
        ? "var(--warn)"
        : status === "err"
          ? "var(--err)"
          : "var(--faint)";
  const statusText = { ok: "Connected", warn: "Degraded", err: "Error", idle: "Offline" }[
    status ?? "idle"
  ];
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) px-4 ${
        secondaryActions ? "py-4" : "py-4"
      } ${onClick ? "cursor-pointer hover:bg-(--panel2)" : ""}`}
      style={{ minHeight: secondaryActions ? 76 : 64 }}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-(--radius-btn) bg-(--panel2)">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-(--text-emph) font-medium text-(--ink)">{title}</span>
          {subtitle && (
            <span className="truncate text-(--text-body) text-(--mute)">{subtitle}</span>
          )}
          {tag && (
            <span
              className="rounded px-1.5 py-0.5 text-(--text-cap)"
              style={{
                background: "color-mix(in srgb, var(--info) 12%, transparent)",
                color: "var(--info)",
              }}
            >
              {tag.label}
            </span>
          )}
          {badges?.map((b, i) => {
            const label = typeof b === "string" ? b : b.label;
            const tone =
              typeof b === "string" || !b.tone
                ? undefined
                : {
                    background: `color-mix(in srgb, var(--${b.tone}) 12%, transparent)`,
                    color: `var(--${b.tone})`,
                  };
            return (
              <span
                key={`${label}-${i}`}
                className="rounded px-1.5 py-0.5 text-(--text-cap) text-(--mute)"
                style={tone}
              >
                {label}
              </span>
            );
          })}
          {idChip && (
            <button
              type="button"
              className="font-mono text-(--text-cap) text-(--faint) hover:text-(--mute)"
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard.writeText(idChip).then(
                  () => import("sonner").then(({ toast }) => toast.success("Copied")),
                  () => {},
                );
              }}
            >
              {idChip}
            </button>
          )}
        </div>
        {desc && <p className="mt-0.5 line-clamp-2 text-(--text-body) text-(--mute)">{desc}</p>}
        {meta && meta.length > 0 && (
          <p className="mt-0.5 text-(--text-cap) text-(--mute)">{meta.join(" · ")}</p>
        )}
        {secondaryActions && <div className="mt-2 flex items-center gap-2">{secondaryActions}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status && (
          <span className="flex items-center gap-1.5 text-(--text-cap) text-(--mute)">
            <span className="size-1.5 rounded-full" style={{ background: statusDot }} />
            {statusText}
          </span>
        )}
        {actions}
      </div>
    </div>
  );
}

/** Search toolbar or batch-selection toolbar. */
export function ListToolbar({
  searchValue,
  onSearch,
  placeholder,
  selection,
}: {
  searchValue?: string;
  onSearch?: (v: string) => void;
  placeholder?: string;
  selection?: {
    total: number;
    selected: number;
    onSelectAll: (v: boolean) => void;
    action?: ReactNode;
  };
}) {
  if (selection) {
    return (
      <div className="flex h-9 items-center gap-3 rounded-(--radius-btn) border border-(--hairline) bg-(--panel) px-3">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={selection.selected === selection.total && selection.total > 0}
          onChange={(e) => selection.onSelectAll(e.target.checked)}
        />
        <span className="text-(--text-body) text-(--mute)">
          Selected {selection.selected}/{selection.total}
        </span>
        <div className="ml-auto">{selection.action}</div>
      </div>
    );
  }
  return (
    <div className="flex h-9 items-center gap-2 rounded-(--radius-btn) bg-(--panel) px-3 focus-within:ring-1 focus-within:ring-(--ok)">
      <span className="text-(--faint)">🔍</span>
      <input
        value={searchValue ?? ""}
        onChange={(e) => onSearch?.(e.target.value)}
        placeholder={placeholder ?? "Search…"}
        className="min-w-0 flex-1 bg-transparent text-(--text-body) text-(--ink) outline-none placeholder:text-(--faint)"
      />
    </div>
  );
}

/** Group kicker with an optional hint line. */
export function SectionKicker({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2">
      <p className="text-(--text-cap) uppercase tracking-kicker font-semibold text-(--mute)">
        {children}
      </p>
      {hint && <p className="mt-0.5 text-(--text-body) text-(--faint)">{hint}</p>}
    </div>
  );
}

/** Install-state badge for resource subsystem rows (pending/installing/
 *  syncing/ready/failed). Failure gets the err tone; everything else stays
 *  neutral. Keep the three channels exclusive (web AGENTS.md): this badge
 *  is install state only — mount is the Switch, connection is the dot. */
export function statusBadge(status: string): { label: string; tone?: "err" } {
  if (status === "pending") return { label: "Pending" };
  if (status === "installing") return { label: "Installing…" };
  if (status === "syncing") return { label: "Syncing…" };
  if (status === "ready") return { label: "Ready" };
  if (status === "failed") return { label: "Failed", tone: "err" };
  return { label: status };
}

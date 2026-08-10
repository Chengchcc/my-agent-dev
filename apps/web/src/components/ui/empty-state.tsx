import type { LucideIcon } from "lucide-react";

/** Minimal structured empty state shared by System/Team/Projects/Chat.
 *  Not a configurable framework: icon + title + description only. */
export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-[var(--hairline)] px-6 py-10 text-center">
      <Icon className="h-5 w-5 text-[var(--mute)]" aria-hidden />
      <p className="text-sm font-medium text-[var(--ink)]">{title}</p>
      {description && <p className="text-xs text-[var(--mute)] max-w-sm">{description}</p>}
    </div>
  );
}

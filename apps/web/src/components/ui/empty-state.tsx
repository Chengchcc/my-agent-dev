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
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-(--hairline) px-6 py-10 text-center">
      <Icon className="size-5 text-(--mute)" aria-hidden />
      <p className="text-sm font-medium text-(--ink)">{title}</p>
      {description && <p className="text-xs text-(--mute) max-w-sm">{description}</p>}
    </div>
  );
}

"use client";

import { Checkbox } from "@/components/ui/checkbox";

export interface ResourceOption {
  id: string;
  name: string;
  hint?: string;
}

interface AgentFormResourceSectionProps {
  title: string;
  items: ResourceOption[];
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
  /** Shown when the catalog is empty (e.g. nothing installed yet). */
  emptyHint?: string;
}

/** Checkbox list for attach-at-create/edit resources (skill packs, MCP
 * servers, knowledge packs) — the catalog+mount model's inline shortcut. */
export function AgentFormResourceSection({
  title,
  items,
  selectedIds,
  onToggle,
  emptyHint,
}: AgentFormResourceSectionProps) {
  if (items.length === 0) {
    if (!emptyHint) return null;
    return (
      <div className="border-t border-(--hairline) pt-5">
        <h3 className="mb-1 text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="border-t border-(--hairline) pt-5">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="max-h-48 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={selectedIds.includes(item.id)}
              onCheckedChange={(checked) => onToggle(item.id, checked === true)}
            />
            <span className="text-sm">{item.name}</span>
            {item.hint && <span className="text-xs text-muted-foreground">({item.hint})</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

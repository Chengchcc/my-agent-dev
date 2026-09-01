"use client";

import { Checkbox } from "@/components/ui/checkbox";

export interface SkillPackOption {
  id: string;
  name: string;
  status: string;
}

interface AgentFormSkillPacksProps {
  isEdit: boolean;
  availablePacks: SkillPackOption[];
  selectedPackIds: string[];
  onToggle: (packId: string, checked: boolean) => void;
}

export function AgentFormSkillPacks({
  isEdit,
  availablePacks,
  selectedPackIds,
  onToggle,
}: AgentFormSkillPacksProps) {
  if (!isEdit || availablePacks.length === 0) return null;

  return (
    <div className="border-t border-(--hairline) pt-5">
      <h3 className="text-sm font-medium mb-3">Skill Packs</h3>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {availablePacks.map((pack) => (
          <label key={pack.id} className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={selectedPackIds.includes(pack.id)}
              onCheckedChange={(checked) => onToggle(pack.id, checked === true)}
            />
            <span className="text-sm">{pack.name}</span>
            <span className="text-xs text-muted-foreground">({pack.status})</span>
          </label>
        ))}
      </div>
    </div>
  );
}

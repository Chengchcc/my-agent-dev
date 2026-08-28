"use client";

import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TriggerPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [cron, setCron] = useState("");
  const triggers = definition.triggers ?? [];

  function setTriggers(next: WorkflowDefinition["triggers"]) {
    onChange({ ...definition, triggers: next });
  }

  function add() {
    if (!cron.trim()) return;
    setTriggers([...triggers, { type: "cron", cron: cron.trim() }]);
    setCron("");
  }

  function toggle(index: number, enabled: boolean) {
    const next = triggers.map((t, i) =>
      i === index ? ({ ...t, enabled } as (typeof triggers)[number]) : t,
    );
    setTriggers(next);
  }

  function remove(index: number) {
    setTriggers(triggers.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3 p-3">
      <div className="space-y-1">
        <Label className="text-xs text-(--mute)">cron trigger（预留定时执行）</Label>
        <div className="flex gap-1">
          <Input
            className="h-8 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs"
            placeholder="0 2 * * *"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button size="sm" onClick={add}>
            添加
          </Button>
        </div>
      </div>
      {triggers.length === 0 && (
        <p className="text-xs text-(--mute)">无定时触发。API 触发无需配置。</p>
      )}
      {triggers.length > 0 && (
        <div className="space-y-1">
          {triggers.map((t, i) => (
            <div
              key={`${i}-${t.cron}`}
              className="flex items-center gap-2 rounded-md border border-(--hairline) px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{t.cron}</span>
              <label className="flex items-center gap-1 text-(--mute)">
                <input
                  type="checkbox"
                  checked={t.enabled !== false}
                  onChange={(e) => toggle(i, e.target.checked)}
                />
                启用
              </label>
              <button onClick={() => remove(i)} className="shrink-0 text-(--err) hover:underline">
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

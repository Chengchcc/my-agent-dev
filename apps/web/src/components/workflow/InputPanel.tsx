"use client";

import type { InputHint, WorkflowDefinition } from "@chengchenccc/workflow";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TYPES = ["string", "number", "boolean", "artifact"] as const;

export function InputPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("string");
  const input = definition.input ?? [];

  function setInput(next: InputHint) {
    onChange({ ...definition, input: next.length > 0 ? next : undefined });
  }

  function add() {
    const k = key.trim();
    if (!k) return;
    setInput([...input, { key: k, type }]);
    setKey("");
  }

  function remove(i: number) {
    setInput(input.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-3 p-3">
      <div className="space-y-1">
        <Label className="text-xs text-(--mute)">workflow 输入参数（运行时可填）</Label>
        <div className="flex gap-1">
          <Input
            className="h-8 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs"
            placeholder="参数名"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Select value={type} onValueChange={(v) => setType((v ?? "string") as typeof type)}>
            <SelectTrigger className="h-8 w-32 border-(--hairline) bg-(--canvas) text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={add}>
            添加
          </Button>
        </div>
      </div>
      {input.length === 0 && <p className="text-xs text-(--mute)">无输入参数。</p>}
      {input.length > 0 && (
        <div className="space-y-1">
          {input.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-(--hairline) px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{f.key}</span>
              <span className="text-(--mute)">{f.type}</span>
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

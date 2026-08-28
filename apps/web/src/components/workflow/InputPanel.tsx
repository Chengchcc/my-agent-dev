"use client";

import type { WorkflowDefinition } from "@chengchenccc/workflow";
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

type InputHint = Record<string, "string" | "number" | "boolean">;

export function InputPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<"string" | "number" | "boolean">("string");
  const input = definition.input ?? {};

  function setInput(next: InputHint) {
    // Only set when non-empty to keep the DSL clean.
    onChange({ ...definition, input: Object.keys(next).length > 0 ? next : undefined });
  }

  function add() {
    const k = key.trim();
    if (!k) return;
    setInput({ ...input, [k]: type });
    setKey("");
  }

  function remove(k: string) {
    const next = { ...input };
    delete next[k];
    setInput(next);
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
            <SelectTrigger className="h-8 w-24 border-(--hairline) bg-(--canvas) text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">string</SelectItem>
              <SelectItem value="number">number</SelectItem>
              <SelectItem value="boolean">boolean</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={add}>
            添加
          </Button>
        </div>
      </div>
      {Object.keys(input).length === 0 && <p className="text-xs text-(--mute)">无输入参数。</p>}
      {Object.keys(input).length > 0 && (
        <div className="space-y-1">
          {Object.entries(input).map(([k, t]) => (
            <div
              key={k}
              className="flex items-center gap-2 rounded-md border border-(--hairline) px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{k}</span>
              <span className="text-(--mute)">{t}</span>
              <button onClick={() => remove(k)} className="shrink-0 text-(--err) hover:underline">
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

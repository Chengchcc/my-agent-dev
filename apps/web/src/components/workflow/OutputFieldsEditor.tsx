"use client";

import type { InputHint } from "@chengchenccc/workflow";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TYPES = ["string", "number", "boolean", "artifact"] as const;

export function OutputFieldsEditor({
  output,
  onChange,
}: {
  output?: InputHint;
  onChange: (output: InputHint) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<(typeof TYPES)[number]>("string");
  const fields = output ?? [];

  function setType(i: number, type: (typeof TYPES)[number]) {
    onChange(fields.map((f, idx) => (idx === i ? { ...f, type } : f)));
  }

  function remove(i: number) {
    onChange(fields.filter((_, idx) => idx !== i));
  }

  function add() {
    const k = newKey.trim();
    if (!k) return;
    onChange([...fields, { key: k, type: newType }]);
    setNewKey("");
  }

  return (
    <div className="space-y-2">
      {fields.length === 0 && <p className="text-xs text-(--faint)">No output fields</p>}
      {fields.map((f, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-(--info)">
            {f.key}
          </span>
          <Select
            value={f.type}
            onValueChange={(v) => setType(i, (v ?? "string") as (typeof TYPES)[number])}
          >
            <SelectTrigger className="h-7 w-32 border-(--hairline) bg-(--canvas) text-[10px]">
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
          <button
            onClick={() => remove(i)}
            className="shrink-0 text-[10px] text-(--err) hover:underline"
          >
            Delete
          </button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          className="h-7 flex-1 border-(--hairline) bg-(--canvas) text-xs"
          placeholder="Field name"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Select
          value={newType}
          onValueChange={(v) => setNewType((v ?? "string") as typeof newType)}
        >
          <SelectTrigger className="h-7 w-32 border-(--hairline) bg-(--canvas) text-[10px]">
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
          Add
        </Button>
      </div>
    </div>
  );
}

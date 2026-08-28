"use client";

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

export function OutputFieldsEditor({
  output,
  onChange,
}: {
  output?: Record<string, string>;
  onChange: (output: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState("string");
  const fields = Object.entries(output ?? {});

  function setType(key: string, type: string) {
    onChange({ ...(output ?? {}), [key]: type });
  }

  function remove(key: string) {
    const next = { ...(output ?? {}) };
    delete next[key];
    onChange(next);
  }

  function add() {
    const k = newKey.trim();
    if (!k) return;
    onChange({ ...(output ?? {}), [k]: newType });
    setNewKey("");
  }

  return (
    <div className="space-y-2">
      {fields.length === 0 && <p className="text-xs text-(--faint)">无输出字段</p>}
      {fields.map(([key, type]) => (
        <div key={key} className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-(--info)">{key}</span>
          <Select value={type} onValueChange={(v) => setType(key, v ?? "string")}>
            <SelectTrigger className="h-7 w-24 border-(--hairline) bg-(--canvas) text-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">string</SelectItem>
              <SelectItem value="number">number</SelectItem>
              <SelectItem value="boolean">boolean</SelectItem>
              <SelectItem value="array">array</SelectItem>
              <SelectItem value="object">object</SelectItem>
            </SelectContent>
          </Select>
          <button
            onClick={() => remove(key)}
            className="shrink-0 text-[10px] text-(--err) hover:underline"
          >
            删除
          </button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          className="h-7 flex-1 border-(--hairline) bg-(--canvas) text-xs"
          placeholder="字段名"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Select value={newType} onValueChange={(v) => setNewType(v ?? "string")}>
          <SelectTrigger className="h-7 w-24 border-(--hairline) bg-(--canvas) text-[10px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">string</SelectItem>
            <SelectItem value="number">number</SelectItem>
            <SelectItem value="boolean">boolean</SelectItem>
            <SelectItem value="array">array</SelectItem>
            <SelectItem value="object">object</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={add}>
          添加
        </Button>
      </div>
    </div>
  );
}

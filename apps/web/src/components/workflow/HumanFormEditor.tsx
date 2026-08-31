"use client";

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

type Field = {
  type?: "string" | "textarea" | "number" | "enum" | "boolean";
  label?: string;
  options?: string[];
  required?: boolean;
};

export function HumanFormEditor({
  form,
  onChange,
}: {
  form?: Record<string, unknown>;
  onChange: (form: Record<string, unknown>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<Field["type"]>("string");
  const fields = Object.entries(form ?? {}) as Array<[string, Field]>;

  function setField(key: string, patch: Partial<Field>) {
    const next = {
      ...(form ?? {}),
      [key]: { ...(fields.find((f) => f[0] === key)?.[1] ?? {}), ...patch },
    };
    onChange(next);
  }

  function removeField(key: string) {
    const next = { ...(form ?? {}) };
    delete next[key];
    onChange(next);
  }

  function addField() {
    const k = newKey.trim();
    if (!k) return;
    const next = { ...(form ?? {}), [k]: { type: newType ?? "string", required: true } };
    onChange(next);
    setNewKey("");
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs text-(--mute)">Form fields</Label>
      {fields.length === 0 && (
        <p className="text-xs text-(--faint)">No fields (question text only)</p>
      )}
      {fields.map(([key, f]) => (
        <div key={key} className="space-y-1 rounded-md border border-(--hairline) p-2">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-(--info)">
              {key}
            </span>
            <button
              onClick={() => removeField(key)}
              className="shrink-0 text-[10px] text-(--err) hover:underline"
            >
              Delete
            </button>
          </div>
          <Select
            value={f.type ?? "string"}
            onValueChange={(v) => setField(key, { type: (v ?? "string") as Field["type"] })}
          >
            <SelectTrigger className="h-7 w-full border-(--hairline) bg-(--canvas) text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">string</SelectItem>
              <SelectItem value="textarea">textarea</SelectItem>
              <SelectItem value="enum">enum</SelectItem>
              <SelectItem value="boolean">boolean</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-7 border-(--hairline) bg-(--canvas) text-xs"
            placeholder="Display label"
            value={f.label ?? ""}
            onChange={(e) => setField(key, { label: e.target.value })}
          />
          {f.type === "enum" && (
            <Input
              className="h-7 border-(--hairline) bg-(--canvas) text-xs"
              placeholder="Options, comma-separated: a,b,c"
              value={(f.options ?? []).join(",")}
              onChange={(e) =>
                setField(key, {
                  options: e.target.value
                    .split(",")
                    .map((o) => o.trim())
                    .filter(Boolean),
                })
              }
            />
          )}
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          className="h-8 flex-1 border-(--hairline) bg-(--canvas) text-xs"
          placeholder="New field name"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addField();
          }}
        />
        <Select
          value={newType ?? "string"}
          onValueChange={(v) => setNewType((v ?? "string") as Field["type"])}
        >
          <SelectTrigger className="h-8 w-24 border-(--hairline) bg-(--canvas) text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">string</SelectItem>
            <SelectItem value="textarea">textarea</SelectItem>
            <SelectItem value="enum">enum</SelectItem>
            <SelectItem value="boolean">boolean</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={addField}>
          Add
        </Button>
      </div>
    </div>
  );
}

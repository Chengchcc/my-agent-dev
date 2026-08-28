"use client";

import type { ArtifactRef } from "@chengchenccc/workflow";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export function ArtifactRefsEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: ArtifactRef[];
  onChange: (next: ArtifactRef[] | undefined) => void;
}) {
  const [url, setUrl] = useState("");
  const [required, setRequiredState] = useState(true);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const refs = value ?? [];

  useEffect(() => {
    api
      .listArtifacts()
      .then((r) => setSuggestions((r.artifacts ?? []).map((a) => a.url)))
      .catch(() => {});
  }, []);

  function add(next?: string) {
    const u = (next ?? url).trim();
    if (!u) return;
    if (refs.some((r) => r.url === u)) return;
    onChange([...refs, { url: u, required }]);
    setUrl("");
  }

  function setRequired(i: number, req: boolean) {
    const next = refs.map((r, idx) => (idx === i ? { ...r, required: req } : r));
    onChange(next);
  }

  function remove(i: number) {
    onChange(refs.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs text-(--mute)">{label}</Label>
      {refs.length === 0 && <p className="text-xs text-(--faint)">无</p>}
      {refs.map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-md border border-(--hairline) px-2 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-(--info)">{r.url}</span>
          <label className="flex shrink-0 items-center gap-1 text-(--mute)">
            <input
              type="checkbox"
              checked={r.required !== false}
              onChange={(e) => setRequired(i, e.target.checked)}
            />
            required
          </label>
          <button onClick={() => remove(i)} className="shrink-0 text-(--err) hover:underline">
            删除
          </button>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          list="artifact-url-suggestions"
          className="h-8 flex-1 border-(--hairline) bg-(--canvas) px-2 text-xs"
          placeholder="artifacts://folder/file"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <datalist id="artifact-url-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button size="sm" onClick={() => add()}>
          添加
        </Button>
      </div>
    </div>
  );
}

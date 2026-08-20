"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type AgentMemory, api } from "@/lib/api";

interface EditableBlockProps {
  title: string;
  value: string;
  hint?: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}

function EditableBlock({ title, value, hint, onChange, onSave, saving }: EditableBlockProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] tracking-widest uppercase text-(--mute)">{title}</h3>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        placeholder={hint ?? "Empty"}
        className="w-full resize-y bg-(--canvas) border border-(--hairline) rounded-md p-2 text-sm text-(--ink) font-mono focus:outline-none focus:border-(--primary)"
      />
    </div>
  );
}

/** Agent memory files, editable. Backed by workspace memory/ files:
 *  memory_summary.md (auto-extracted digest), MEMORY.md (agent ledger),
 *  memory/facts/*.md (auto-extracted facts, one file per run). */
export function MemoryPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["agent-memory", agentId],
    queryFn: () => api.getAgentMemory(agentId) as Promise<AgentMemory>,
  });

  const [summary, setSummary] = useState("");
  const [memoryMd, setMemoryMd] = useState("");
  const [factDrafts, setFactDrafts] = useState<Record<string, string>>({});
  const [synced, setSynced] = useState(false);
  if (data && !synced) {
    setSummary(data.memSummary ?? "");
    setMemoryMd(data.memoryMd ?? "");
    setFactDrafts(Object.fromEntries(data.memories.map((m) => [m.file, m.content])));
    setSynced(true);
  }

  const saveMut = useMutation({
    mutationFn: (body: Parameters<typeof api.updateAgentMemory>[1]) =>
      api.updateAgentMemory(agentId, body),
    onSuccess: () => {
      setSynced(false);
      void qc.invalidateQueries({ queryKey: ["agent-memory", agentId] });
    },
  });
  const saving = saveMut.isPending;

  if (isLoading) return <div className="text-sm text-(--mute)">Loading memories...</div>;
  if (!data) return <div className="text-sm text-(--mute)">No memory data.</div>;

  return (
    <div className="space-y-6">
      <EditableBlock
        title="Summary (auto-extracted digest)"
        value={summary}
        hint="memory/memory_summary.md — regenerated after each run from new facts"
        onChange={setSummary}
        onSave={() => saveMut.mutate({ memSummary: summary })}
        saving={saving}
      />

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-[10px] tracking-widest uppercase text-(--mute)">
            Facts ({data.memories.length})
          </h3>
        </div>
        {data.memories.length === 0 ? (
          <p className="text-sm text-(--mute)">No memories extracted yet.</p>
        ) : (
          <div className="space-y-3">
            {data.memories.map((m) => (
              <div key={m.file} className="rounded border border-(--hairline) p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-(--mute)">{m.file}</p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={saving}
                      onClick={() =>
                        saveMut.mutate({
                          facts: [{ file: m.file, content: factDrafts[m.file] ?? m.content }],
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-destructive"
                      disabled={saving}
                      onClick={() => saveMut.mutate({ deleteFacts: [m.file] })}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <Textarea
                  value={factDrafts[m.file] ?? m.content}
                  onChange={(e) => setFactDrafts((prev) => ({ ...prev, [m.file]: e.target.value }))}
                  rows={4}
                  className="w-full resize-y bg-(--canvas) border border-(--hairline) rounded-md p-2 text-sm text-(--ink) font-mono focus:outline-none focus:border-(--primary)"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <EditableBlock
        title="MEMORY.md (agent ledger)"
        value={memoryMd}
        hint="memory/MEMORY.md — the agent's own dated ledger"
        onChange={setMemoryMd}
        onSave={() => saveMut.mutate({ memoryMd })}
        saving={saving}
      />
    </div>
  );
}

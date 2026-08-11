"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAgentIdentity, useSetIdentity } from "@/features/agents/hooks";
import { overlineClass } from "@/lib/form-styles";

interface SectionProps {
  title: string;
  content: string | null;
  field: "soul" | "user";
  editing: boolean;
  draft: string;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onChange: (value: string) => void;
}

function Section({
  title,
  content,
  editing,
  draft,
  saving,
  onEdit,
  onCancel,
  onSave,
  onChange,
}: SectionProps) {
  return (
    <div className="border border-(--hairline) rounded-lg p-8 bg-(--canvas)">
      <div className="flex items-center justify-between mb-4">
        <h3 className={overlineClass}>{title}</h3>
        {!editing && (
          <Button onClick={onEdit} variant="ghost" size="xs">
            <Pencil size={12} />
            <span className="text-[10px]">Edit</span>
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-3">
          <Textarea
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-[200px] resize-y font-mono"
          />
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={saving} size="sm">
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button onClick={onCancel} disabled={saving} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      ) : content === null ? (
        <p className="text-sm text-(--mute)">Not yet configured</p>
      ) : (
        <pre className="text-sm/relaxed text-(--ink) whitespace-pre-wrap font-sans max-h-80 overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

export function IdentityPanel({ agentId }: { agentId: string }) {
  const [editingField, setEditingField] = useState<"soul" | "user" | null>(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useAgentIdentity(agentId);
  const saveMutation = useSetIdentity(agentId);

  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-32 bg-(--canvas-soft) rounded-lg" />
        <div className="h-32 bg-(--canvas-soft) rounded-lg" />
        <div className="h-20 bg-(--canvas-soft) rounded-lg" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-(--mute)">Failed to load identity</p>;
  }

  const startEdit = (field: "soul" | "user") => {
    setDraft(data[field] ?? "");
    setEditingField(field);
  };

  const save = () => {
    if (editingField) {
      saveMutation.mutate({ [editingField]: draft }, { onSuccess: () => setEditingField(null) });
    }
  };

  const cancel = () => setEditingField(null);

  return (
    <div className="space-y-4 max-w-2xl">
      <Section
        title="SOUL"
        content={data.soul}
        field="soul"
        editing={editingField === "soul"}
        draft={draft}
        saving={saveMutation.isPending}
        onEdit={() => startEdit("soul")}
        onCancel={cancel}
        onSave={save}
        onChange={setDraft}
      />
      <Section
        title="USER"
        content={data.user}
        field="user"
        editing={editingField === "user"}
        draft={draft}
        saving={saveMutation.isPending}
        onEdit={() => startEdit("user")}
        onCancel={cancel}
        onSave={save}
        onChange={setDraft}
      />
    </div>
  );
}

"use client";

import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";
import Editor from "@monaco-editor/react";
import { useState } from "react";
import { api } from "@/lib/api";

export function DslEditorPanel({
  workflowId,
  definition,
  onChange,
}: {
  workflowId: string;
  definition: unknown;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [text, setText] = useState<string>(definition ? JSON.stringify(definition, null, 2) : "");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Sync the editor text when the shared definition changes and the local
  // editor is not dirty (canvas/inspector edits must not be silently rolled
  // back by a stale text snapshot on Save).
  const serialized = definition ? JSON.stringify(definition, null, 2) : "";
  if (!dirty && text !== serialized) setText(serialized);

  function parse(): WorkflowDefinition | null {
    try {
      const parsed = JSON.parse(text);
      const validated = parseWorkflow(parsed);
      return validated;
    } catch (err) {
      setMessage(`Invalid DSL: ${(err as Error).message}`);
      return null;
    }
  }

  function apply() {
    const parsed = parse();
    if (parsed) setDirty(false);
    if (parsed) {
      onChange(parsed);
      setMessage("Applied to canvas.");
    }
  }

  async function save() {
    const parsed = parse();
    if (!parsed) return;
    try {
      await api.saveWorkflowDefinition(workflowId, parsed as unknown as Record<string, unknown>);
      onChange(parsed);
      setMessage("Saved.");
    } catch (err) {
      setMessage(`Save failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 text-sm font-semibold">Workflow DSL</div>
      <Editor
        height="60vh"
        defaultLanguage="json"
        value={text}
        onChange={(v) => {
          setText(v ?? "");
          setDirty((v ?? "") !== serialized);
        }}
        options={{ minimap: { enabled: false }, fontSize: 12 }}
      />
      <div className="mt-2 flex gap-2">
        <button className="rounded bg-slate-800 px-3 py-1 text-white" onClick={apply}>
          Apply
        </button>
        <button className="rounded border px-3 py-1" onClick={save}>
          Save
        </button>
      </div>
      {message && <div className="mt-2 text-xs text-muted-foreground">{message}</div>}
    </div>
  );
}

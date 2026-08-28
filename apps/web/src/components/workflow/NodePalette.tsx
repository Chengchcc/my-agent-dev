"use client";

import type { WorkflowNode } from "@chengchenccc/workflow";

const DEFAULT_NODE: Record<string, () => WorkflowNode> = {
  agent: () => ({ id: "", type: "agent", agentId: "", prompt: "" }),
  script: () => ({ id: "", type: "script", code: "export default async () => ({})" }),
  human: () => ({ id: "", type: "human", question: "" }),
  end: () => ({ id: "", type: "end", status: "success" }),
};

/** Node creation palette: inserts a per-type default node into the DSL. */
export function NodePalette({ onAdd }: { onAdd: (node: WorkflowNode) => void }) {
  return (
    <div className="flex gap-2 border-b p-2">
      {Object.keys(DEFAULT_NODE).map((t) => (
        <button
          key={t}
          className="rounded border px-2 py-1 text-xs hover:bg-muted/50"
          onClick={() => onAdd(DEFAULT_NODE[t]!())}
        >
          + {t}
        </button>
      ))}
    </div>
  );
}

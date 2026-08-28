"use client";

import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { Sparkles, WandSparkles } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";

export function ChatPanel({
  workflowId,
  definition,
  onApply,
}: {
  workflowId: string;
  definition: WorkflowDefinition;
  onApply: (def: WorkflowDefinition) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [patched, setPatched] = useState<WorkflowDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  async function run() {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setHistory((h) => [...h, text]);
    try {
      const res = await api.chatPatchWorkflow(workflowId, definition, text);
      setPatched(res.definition);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setInstruction("");
    }
  }

  function apply() {
    if (!patched) return;
    onApply(patched);
    setPatched(null);
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-(--info)" />
        Chat
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1 text-xs">
        <div className="text-(--mute)">
          用自然语言描述改动，agent 会生成对应的 DSL patch，预览后 Apply 到画布。
        </div>
        {history.map((h, i) => (
          <div
            key={i}
            className="rounded-lg border border-(--hairline) bg-(--panel2)/60 p-2 text-(--ink)"
          >
            {h}
          </div>
        ))}
        {patched && (
          <div className="rounded-lg border border-(--primary)/30 bg-(--primary)/5 p-2">
            <div className="mb-1 text-(--primary)">
              <WandSparkles className="mr-1 inline size-3.5" />
              agent 生成 {patched.nodes.length} 节点 / {patched.edges.length} 边
            </div>
            <button
              onClick={apply}
              className="rounded-md bg-(--primary) px-2 py-1 text-xs text-(--ink)"
            >
              Apply
            </button>
          </div>
        )}
        {error && <div className="rounded-md bg-(--err)/10 p-2 text-(--err)">{error}</div>}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) run();
          }}
          placeholder="描述要改什么…"
          className="min-w-0 flex-1 rounded-md border border-(--hairline) bg-(--canvas) px-2 py-1.5 text-xs text-(--ink) outline-none placeholder:text-(--mute) focus:border-(--info)"
        />
        <button
          onClick={run}
          className="rounded-md bg-(--info) px-2.5 py-1.5 text-xs text-(--ink) hover:bg-(--panel2)"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

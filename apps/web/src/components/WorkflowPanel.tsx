import type { WorkflowRunState } from "@/hooks/useConversation";

/** Transient workflow progress (Phase 1): one collapsible card per running
 *  workflow with per-agent status. Durable truth is the tool result message. */
export function WorkflowPanel({ workflows }: { workflows: ReadonlyMap<string, WorkflowRunState> }) {
  const running = [...workflows.entries()].filter(([, w]) => w.ok === null);
  if (running.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
      {running.map(([workflowId, w]) => {
        const done = [...w.agents.values()].filter((a) => a.status !== "running").length;
        return (
          <div key={workflowId}>
            <div className="font-medium">
              {w.label} · {done}/{w.agentCount} agents
            </div>
            <ul className="mt-1 space-y-0.5">
              {[...w.agents.entries()].map(([agentId, a]) => {
                const mark = a.status === "running" ? "⏳" : a.status === "done" ? "✓" : "✗";
                return (
                  <li key={agentId} className={a.status === "failed" ? "text-red-600" : ""}>
                    {mark} {a.label}
                    {a.error ? ` — ${a.error.slice(0, 80)}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

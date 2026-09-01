"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { toast } from "sonner";
import { ListRowCard } from "@/components/ui/polish";
import { agentKeys } from "@/features/agents/query-keys";
import { useProjectList } from "@/features/projects/hooks";
import { type AgentRow, api } from "@/lib/api";

/** Projects tab (ADR 0023): toggle which projects this agent attaches to.
 *  Attachment materializes a git worktree under the agent workspace. */
export function AgentProjectsPanel({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const { data } = useProjectList();
  const attached = agent.projects ?? [];

  async function toggle(projectId: string) {
    const next = attached.includes(projectId)
      ? attached.filter((p) => p !== projectId)
      : [...attached, projectId];
    try {
      await api.updateAgent(agent.id, { projects: next });
      // Refresh both the detail and list queries so every view picks up the change.
      await qc.invalidateQueries({ queryKey: agentKeys.detail(agent.id) });
      await qc.invalidateQueries({ queryKey: agentKeys.lists() });
      toast.success(next.includes(projectId) ? "Project attached" : "Project detached");
    } catch (err) {
      toast.error("Failed to update projects", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const projects = data?.projects ?? [];
  return (
    <div className="space-y-2" data-testid="agent-projects">
      {projects.length === 0 ? (
        <p className="text-sm text-(--mute)" data-testid="empty-state">
          No projects yet. Create one under Team → Projects.
        </p>
      ) : (
        projects.map((p) => (
          <ListRowCard
            key={p.projectId}
            icon={<FolderGit2 size={16} className="text-(--mute)" />}
            title={p.name}
            idChip={p.projectId}
            desc={p.repoUrl ?? undefined}
            tag={attached.includes(p.projectId) ? { label: "attached" } : undefined}
            actions={
              <button
                type="button"
                onClick={() => void toggle(p.projectId)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  attached.includes(p.projectId)
                    ? "border-(--err)/40 text-(--err) hover:bg-(--err)/10"
                    : "border-(--primary)/40 text-(--primary) hover:bg-(--primary)/10"
                }`}
              >
                {attached.includes(p.projectId) ? "Detach" : "Attach"}
              </button>
            }
          />
        ))
      )}
    </div>
  );
}

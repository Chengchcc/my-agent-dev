"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FastForward, GitBranch, GitMerge } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ListRowCard } from "@/components/ui/polish";
import { useAgentList } from "@/features/agents/hooks";
import { useProjectWorktreeDiff } from "@/features/projects/hooks";
import { projectKeys } from "@/features/projects/query-keys";
import { api } from "@/lib/api";

export interface WorktreeRow {
  agentId: string;
  branch: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
}

/** One agent's worktree card: branch status vs the project base branch,
 *  expandable diff, in-page fast-forward / merge (ADR 0023 P2). */
export function WorktreeCard({ projectId, row }: { projectId: string; row: WorktreeRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState(false);
  const [acting, setActing] = useState<"fast-forward" | "merge" | null>(null);
  const { data: agents } = useAgentList();
  const agentName = agents?.find((a) => a.id === row.agentId)?.name ?? row.agentId;
  const { data: diff } = useProjectWorktreeDiff(projectId, row.agentId, open);

  async function act(kind: "fast-forward" | "merge") {
    if (acting) return; // P2: no double submission
    const confirmed = window.confirm(
      `${kind === "merge" ? "Merge" : "Fast-forward"} ${row.branch} into the base branch` +
        `${push ? " and push to origin" : ""}?`,
    );
    if (!confirmed) return;
    setActing(kind);
    try {
      if (kind === "fast-forward") {
        await api.projectWorktreeFastForward(projectId, row.agentId, push);
      } else {
        await api.projectWorktreeMerge(projectId, row.agentId, push);
      }
      // P2: the diff must refresh with the new base too.
      await qc.invalidateQueries({ queryKey: projectKeys.worktrees(projectId) });
      await qc.invalidateQueries({ queryKey: projectKeys.worktreeDiff(projectId, row.agentId) });
      toast.success(kind === "merge" ? "Merged" : "Fast-forwarded");
    } catch (err) {
      toast.error(`Failed to ${kind}`, {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActing(null);
    }
  }

  return (
    <div data-testid="worktree-card" className="space-y-2">
      <ListRowCard
        icon={<GitBranch size={16} className="text-(--mute)" />}
        title={agentName}
        idChip={row.branch}
        desc={row.worktreeReady ? undefined : "worktree not materialized — attach to materialize"}
        meta={[`ahead ${row.ahead}`, `behind ${row.behind}`]}
        tag={row.ahead > 0 ? { label: "has changes" } : undefined}
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-(--mute)">
              <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
              push
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void act("fast-forward")}
              disabled={row.ahead === 0 || acting !== null}
              title={row.ahead === 0 ? "Nothing ahead of the base branch" : undefined}
            >
              <FastForward size={12} /> FF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void act("merge")}
              disabled={row.ahead === 0 || acting !== null}
              title={row.ahead === 0 ? "Nothing ahead of the base branch" : undefined}
            >
              <GitMerge size={12} /> Merge
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide diff" : "Diff"}
            </Button>
          </div>
        }
      />
      {open && (
        <pre className="max-h-96 overflow-auto rounded-lg border border-(--hairline) bg-(--panel) p-3 text-xs/relaxed  text-(--body)">
          {(diff?.diff ?? "loading…").split("\n").slice(0, 200).join("\n")}
        </pre>
      )}
    </div>
  );
}

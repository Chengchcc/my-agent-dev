"use client";

import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { WorktreeCard } from "@/app/(main)/team/projects/_components/worktree-card";
import { PackAgentsTab } from "@/components/pack-agents-tab";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import { Text } from "@/components/ui/text";
import { useProjectWorktrees } from "@/features/projects/hooks";
import type { AgentRow, ProjectRow } from "@/lib/api";

export function ProjectDetailSheet({
  project,
  agents,
  onEdit,
  onAssign,
  onRemove,
  onClose,
}: {
  project: ProjectRow;
  agents: AgentRow[];
  onEdit: () => void;
  onAssign: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "worktrees" | "agents">("overview");
  const { data: wtRes, isLoading, error: wtErr } = useProjectWorktrees(project.projectId);
  const usedBy = agents.filter((a) => a.projects?.includes(project.projectId));

  const worktrees = wtRes?.worktrees ?? [];

  return (
    <ResourceDetailSheet
      open
      onClose={onClose}
      icon={<FolderGit2 className="size-5 text-(--mute)" />}
      title={project.name}
      subtitle={project.repoUrl ?? undefined}
      tabs={[
        { key: "overview", label: "Overview" },
        { key: "worktrees", label: "Worktrees" },
        { key: "agents", label: "Agents" },
      ]}
      tab={tab}
      onTabChange={(key) => setTab(key as "overview" | "worktrees" | "agents")}
      breadcrumb={[
        { label: project.name },
        { label: tab === "worktrees" ? "Worktrees" : tab === "agents" ? "Agents" : "Overview" },
      ]}
      footer={
        <>
          <Text as="p" className="mr-auto text-xs text-(--mute)">
            {usedBy.length} attached agent{usedBy.length > 1 ? "s" : ""}
          </Text>
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Link
            href={`/team/projects/${project.projectId}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open full page
          </Link>
        </>
      }
    >
      {tab === "overview" && (
        <div className="space-y-4">
          <Text as="p" className="text-sm text-(--mute)">
            {project.repoUrl ?? "No repository configured"}
          </Text>
          <dl className="space-y-1 text-sm">
            <DetailRow label="Repository" value={project.repoUrl ?? "—"} />
            <DetailRow label="Default branch" value={project.defaultBranch ?? "—"} />
            <DetailRow label="Created" value={new Date(project.createdAt).toLocaleDateString()} />
            <DetailRow label="Attached" value={`${usedBy.length} agents`} />
          </dl>
        </div>
      )}

      {tab === "agents" && (
        <PackAgentsTab
          agents={agents}
          usedBy={usedBy}
          isAssigned={(agentId) =>
            Boolean(agents.find((a) => a.id === agentId)?.projects?.includes(project.projectId))
          }
          onAssign={onAssign}
          onRemove={onRemove}
        />
      )}

      {tab === "worktrees" && (
        <div className="space-y-3">
          {isLoading ? (
            <Text as="p" className="text-sm text-(--mute)">
              Loading worktrees…
            </Text>
          ) : wtErr ? (
            <Text as="p" className="text-sm text-(--err)">
              {String(wtErr instanceof Error ? wtErr.message : "failed to load worktrees")}
            </Text>
          ) : worktrees.length === 0 ? (
            <EmptyState
              icon={FolderGit2}
              title="No attached agents"
              description="Attach the project on an agent's detail page (Projects tab) to materialize a worktree."
            />
          ) : (
            worktrees.map((w) => (
              <WorktreeCard key={w.agentId} projectId={project.projectId} row={w} />
            ))
          )}
        </div>
      )}
    </ResourceDetailSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Text as="dt" className="text-(--mute)">
        {label}
      </Text>
      <Text as="dd" className="truncate text-right">
        {value}
      </Text>
    </div>
  );
}

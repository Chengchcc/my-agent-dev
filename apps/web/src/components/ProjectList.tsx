"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ProjectDetailSheet } from "@/components/ProjectDetailSheet";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ResourceCard,
  ResourceCardContent,
  ResourceCardFooter,
  ResourceCardHeader,
  ResourceTag,
} from "@/components/ui/resource-card";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useDeleteProject, useProjectList } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { api } from "@/lib/api";
import { ProjectForm } from "./ProjectForm";

export function ProjectList() {
  const [editingProject, setEditingProject] = useState<ProjectRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: projectsData, isLoading } = useProjectList();
  const remove = useDeleteProject();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const qc = useQueryClient();

  const { data: agentsData } = useAgentList();

  const projects = useMemo(() => projectsData?.projects ?? [], [projectsData]);
  const selectedProject = projects.find((p) => p.projectId === selectedId) ?? null;

  const handleDelete = async (project: ProjectRow) => {
    const ok = await confirm({
      title: `Delete project "${project.name}"?`,
      description: "This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) {
      remove.mutate(project.projectId, {
        onError: (err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          const is409 = message.includes("409") || message.toLowerCase().includes("still has");
          toast.error(
            is409 ? "Cannot delete — project still has issues" : "Failed to delete project",
            { description: message },
          );
        },
      });
    }
  };

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-lg border border-(--hairline) bg-(--canvas)"
          />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="mb-2 text-lg text-(--mute)">No projects yet</p>
        <p className="text-sm text-(--mute)">Create a project to start managing issues.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => {
          return (
            <ResourceCard key={project.projectId} tone={project.repoUrl ? "info" : "warn"}>
              <ResourceCardHeader
                icon={<FolderGit2 className="size-4 text-(--mute)" />}
                title={project.name}
              />
              <ResourceCardContent>
                <p className="line-clamp-2 text-sm text-(--mute)">
                  {project.repoUrl ?? "No repository configured"}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  <ResourceTag label={project.repoUrl ? "repository" : "no repo"} tone="info" />
                  {project.defaultBranch && (
                    <ResourceTag label={project.defaultBranch} tone="info" />
                  )}
                </div>
                <p className="text-xs text-(--mute)">
                  Created{" "}
                  {new Date(project.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </ResourceCardContent>
              <ResourceCardFooter
                meta={`● ${project.repoUrl ? "repository" : "no repo"}`}
                action={{ label: "View", onClick: () => setSelectedId(project.projectId) }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(--err) hover:bg-(--err)/10"
                  aria-label={`Delete ${project.name}`}
                  onClick={() => void handleDelete(project)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </ResourceCardFooter>
            </ResourceCard>
          );
        })}
      </div>

      {editingProject && (
        <ProjectForm
          key={editingProject.projectId}
          editProject={editingProject}
          onSuccess={() => setEditingProject(null)}
        />
      )}

      {selectedProject && (
        <ProjectDetailSheet
          key={selectedProject.projectId}
          project={selectedProject}
          agents={agentsData ?? []}
          onEdit={() => setEditingProject(selectedProject)}
          onAssign={(agentId) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = [...(agent?.projects ?? []), selectedProject.projectId];
            void api.updateAgent(agentId, { projects: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onRemove={(agentId) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = (agent?.projects ?? []).filter((id) => id !== selectedProject.projectId);
            void api.updateAgent(agentId, { projects: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onClose={() => setSelectedId(null)}
        />
      )}

      {confirmDialog}
    </>
  );
}

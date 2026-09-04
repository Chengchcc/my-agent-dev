"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { ProjectDetailSheet } from "@/components/ProjectDetailSheet";
import { Button } from "@/components/ui/button";
import { ResourceCard } from "@/components/ui/resource-card";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useDeleteProject, useProjectList } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { api } from "@/lib/api";
import { ProjectForm } from "./ProjectForm";

export function ProjectList() {
  const [editingProject, setEditingProject] = useState<ProjectRow | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: projectsData, isLoading } = useProjectList();
  const remove = useDeleteProject();

  const qc = useQueryClient();
  const { data: agentsData } = useAgentList();

  const projects = useMemo(() => projectsData?.projects ?? [], [projectsData]);
  const selectedProject = projects.find((p) => p.projectId === selectedId) ?? null;

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
          const usedByAgents = (agentsData ?? [])
            .filter((a) => a.projects?.includes(project.projectId))
            .map((a) => a.name);
          const onAssign = (agentId: string) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = [...(agent?.projects ?? []), project.projectId];
            void api.updateAgent(agentId, { projects: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          };
          return (
            <ResourceCard
              key={project.projectId}
              icon={<FolderGit2 className="size-4 text-(--mute)" />}
              title={project.name}
              description={project.repoUrl ?? "No repository configured"}
              tags={[
                {
                  label: project.repoUrl ? "repository" : "no repo",
                  tone: "info",
                },
                ...(project.defaultBranch
                  ? [{ label: project.defaultBranch, tone: "info" as const }]
                  : []),
              ]}
              lint={
                usedByAgents.length
                  ? [
                      {
                        label: `${usedByAgents.length} agent${usedByAgents.length > 1 ? "s" : ""}`,
                        tone: "ok" as const,
                      },
                    ]
                  : [{ label: "not attached", tone: "warn" as const }]
              }
              meta={`Created ${new Date(project.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
              footer={
                <>
                  <AssignToAgentSelect
                    agents={agentsData ?? []}
                    assigned={(agentId) =>
                      Boolean(
                        (agentsData ?? [])
                          .find((ag) => ag.id === agentId)
                          ?.projects?.includes(project.projectId),
                      )
                    }
                    onAssign={onAssign}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedId(project.projectId)}
                  >
                    View
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditingProject(project)}>
                    Edit
                  </Button>
                  {confirmingId === project.projectId ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          remove.mutate(project.projectId, {
                            onSuccess: () => {
                              toast.success("Project deleted");
                              setConfirmingId(null);
                            },
                            onError: (err) => {
                              const message = err instanceof Error ? err.message : "Unknown error";
                              const is409 =
                                message.includes("409") ||
                                message.toLowerCase().includes("still has");
                              toast.error(
                                is409
                                  ? "Cannot delete — project still has issues"
                                  : "Failed to delete project",
                                { description: message },
                              );
                            },
                          });
                        }}
                        disabled={remove.isPending}
                      >
                        Confirm
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmingId(project.projectId)}
                    >
                      Delete
                    </Button>
                  )}
                </>
              }
              onClick={() => setSelectedId(project.projectId)}
            />
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
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

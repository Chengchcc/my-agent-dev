"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDeleteProject, useProjectList } from "@/features/projects/hooks";
import type { ProjectRow } from "@/lib/api";
import { ProjectForm } from "./ProjectForm";

export function ProjectList() {
  const [editingProject, setEditingProject] = useState<ProjectRow | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data: projectsData, isLoading } = useProjectList();

  const remove = useDeleteProject();

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-(--hairline) rounded-lg bg-(--canvas) p-8 animate-pulse"
          >
            <div className="h-5 w-32 bg-(--canvas-soft) mb-3" />
            <div className="h-4 w-24 bg-(--canvas-soft)" />
          </div>
        ))}
      </div>
    );
  }

  const projects = projectsData?.projects ?? [];

  if (projects.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="text-lg text-(--mute) mb-2 font-sans">No projects yet</p>
        <p className="text-sm text-(--mute)">Create a project to start managing issues.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <div key={project.projectId} className="relative group">
            <div
              className="block border border-(--hairline) rounded-lg bg-(--canvas) p-8
                         "
              style={{}}
            >
              <h3
                className="text-xl font-normal text-(--ink-strong) tracking-tight font-sans"
                style={{ letterSpacing: "-0.65px" }}
              >
                {project.name}
              </h3>

              <div className="mt-3 flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-(--primary) opacity-60" />
                <span
                  className="text-xs text-(--mute) tracking-wider uppercase font-sans font-semibold"
                  style={{ letterSpacing: "2.52px" }}
                >
                  {project.repoUrl ? "repository configured" : "no repository"}
                </span>
              </div>

              {project.repoUrl && (
                <p className="mt-2 text-xs text-(--mute) truncate">
                  {project.repoUrl}
                  {project.defaultBranch ? ` (${project.defaultBranch})` : ""}
                </p>
              )}

              <div className="mt-4 text-[10px] text-(--mute)">
                Created{" "}
                {new Date(project.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </div>
            </div>

            {/* Edit / Delete controls */}
            <div className="absolute top-3 right-3 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="xs"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingProject(project);
                }}
              >
                Edit
              </Button>
              {confirmingId === project.projectId ? (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      remove.mutate(project.projectId, {
                        onSuccess: () => {
                          toast.success("Project deleted");
                          setConfirmingId(null);
                        },
                        onError: (err) => {
                          const message = err instanceof Error ? err.message : "Unknown error";
                          const is409 =
                            message.includes("409") || message.toLowerCase().includes("still has");
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
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfirmingId(null);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmingId(project.projectId);
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Edit modal — controlled via key to remount when switching targets */}
      {editingProject && (
        <ProjectForm
          key={editingProject.projectId}
          editProject={editingProject}
          onSuccess={() => setEditingProject(null)}
        />
      )}
    </>
  );
}

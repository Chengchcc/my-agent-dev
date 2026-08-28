"use client";

import { FolderGit2 } from "lucide-react";
import { useParams } from "next/navigation";
import { Page, PageBody, PageHeader } from "@/components/page";
import { EmptyState } from "@/components/ui/empty-state";
import { useProjectDetail, useProjectWorktrees } from "@/features/projects/hooks";
import { WorktreeCard } from "../_components/worktree-card";

/** Project aggregate (ADR 0023 P2): the project's every attached
 *  agent's worktree with branch status, diff and merge actions. */
export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { data: projectRes, error: projectErr, isError } = useProjectDetail(projectId);
  const { data: wtRes, error: wtErr } = useProjectWorktrees(projectId);
  const project = projectRes?.project;
  const worktrees = wtRes?.worktrees ?? [];
  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Projects"
        title={project?.name ?? projectId}
        description={project?.repoUrl ?? undefined}
      />
      <PageBody size="reading" className="space-y-8">
        <section className="space-y-3" data-testid="project-worktrees">
          <h2 className="text-sm font-medium">Worktrees</h2>
          {(isError || wtErr) && (
            <div
              data-testid="project-error"
              className="rounded-lg border border-(--err)/40 bg-(--err)/10 p-3 text-sm text-(--err)"
            >
              {String(
                (wtErr ?? projectErr) instanceof Error
                  ? (wtErr ?? projectErr)?.message
                  : "failed to load project data",
              )}
            </div>
          )}
          {!isError && !wtErr && worktrees.length === 0 ? (
            <div data-testid="empty-state">
              <EmptyState
                icon={FolderGit2}
                title="No attached agents"
                description="Attach the project on an agent's detail page (Projects tab) to materialize a worktree."
              />
            </div>
          ) : (
            worktrees.map((w) => <WorktreeCard key={w.agentId} projectId={projectId} row={w} />)
          )}
        </section>
      </PageBody>
    </Page>
  );
}

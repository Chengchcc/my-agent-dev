"use client";

import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Page, PageBody, PageHeader } from "@/components/page";
import { EmptyState } from "@/components/ui/empty-state";
import { useLoopList } from "@/features/loop/hooks";
import { useProjectDetail, useProjectWorktrees } from "@/features/projects/hooks";
import { WorktreeCard } from "../_components/worktree-card";

/** Project aggregate (ADR 0023 P2): the project's loops and every attached
 *  agent's worktree with branch status, diff and merge actions. */
export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { data: projectRes, error: projectErr, isError } = useProjectDetail(projectId);
  const { data: wtRes, error: wtErr } = useProjectWorktrees(projectId);
  const { data: loopsRes } = useLoopList();

  const project = projectRes?.project;
  const worktrees = wtRes?.worktrees ?? [];
  const loops = (loopsRes?.loops ?? []).filter(
    (l) => "projectId" in l && l.projectId === projectId,
  );

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
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Loops</h2>
          {loops.length === 0 ? (
            <p className="text-sm text-(--mute)" data-testid="empty-state">
              No loops reference this project.
            </p>
          ) : (
            loops.map((l) => (
              <Link
                key={l.cronJobId}
                href={`/work/${l.cronJobId}`}
                className="block rounded-lg border border-(--hairline) bg-(--canvas) px-4 py-3 text-sm text-(--body) hover:border-(--primary) transition-colors"
              >
                {l.name}
              </Link>
            ))
          )}
        </section>
      </PageBody>
    </Page>
  );
}

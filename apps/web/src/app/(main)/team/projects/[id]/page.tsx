"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Page, PageBody, PageHeader } from "@/components/page";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api";
import { WorktreeCard } from "../_components/worktree-card";

/** Project aggregate (ADR 0023 P2): the project's loops and every attached
 *  agent's worktree with branch status, diff and merge actions. */
export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { data: projectRes } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const { data: wtRes } = useQuery({
    queryKey: ["project-worktrees", projectId],
    queryFn: () => api.listProjectWorktrees(projectId),
  });
  const { data: loopsRes } = useQuery({
    queryKey: ["loops"],
    queryFn: () => api.listLoops(),
  });

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
          {worktrees.length === 0 ? (
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

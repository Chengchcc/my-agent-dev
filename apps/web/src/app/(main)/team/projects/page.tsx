import { ProjectForm } from "@/components/ProjectForm";
import { ProjectList } from "@/components/ProjectList";
import { Page, PageBody, PageHeader } from "@/components/page";
import { InfoBanner } from "@/components/ui/polish";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team" },
          { label: "Projects", href: "/team/projects" },
        ]}
        title="Projects"
        description="Repositories and automation targets."
        action={<ProjectForm />}
      />
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:projects-help"
            title="How this page works"
            body="Projects materialize a repo worktree per agent. Create a project, then attach it to agents from the project's Agents tab so runs operate against its mirror."
          />
          <ProjectList />
        </div>
      </PageBody>
    </Page>
  );
}

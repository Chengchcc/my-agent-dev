import { ProjectForm } from "@/components/ProjectForm";
import { ProjectList } from "@/components/ProjectList";
import { Page, PageBody, PageHeader } from "@/components/page";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Team", href: "/team/agents" },
          { label: "Projects", href: "/team/projects" },
        ]}
        title="Projects"
        description="Repositories and automation targets."
        action={<ProjectForm />}
      />
      <PageBody>
        <ProjectList />
      </PageBody>
    </Page>
  );
}

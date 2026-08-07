import { AgentForm } from "@/components/AgentForm";
import { AgentList } from "@/components/AgentList";
import { Page, PageBody, PageHeader } from "@/components/page";

export default function AgentsPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb="Team"
        title="Agents"
        description="Agent identities, workspaces and relationships."
        action={<AgentForm />}
      />
      <PageBody>
        <AgentList />
      </PageBody>
    </Page>
  );
}

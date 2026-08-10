import { Page, PageBody, PageHeader } from "@/components/page";
import { SkillPackManager } from "@/components/SkillPackManager";

export default function SkillPacksPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Skill Packs"
        title="Skill Packs"
        description="Install and manage skill packs for agents."
      />
      <PageBody>
        <SkillPackManager />
      </PageBody>
    </Page>
  );
}

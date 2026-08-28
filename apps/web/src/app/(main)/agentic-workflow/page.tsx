import { parseEnv } from "@chengchenccc/config";
import { WorkflowList } from "@/components/workflow/WorkflowList";
import { createServerClient, unwrap } from "@/lib/client";

export const dynamic = "force-dynamic";

export default async function AgenticWorkflowListPage() {
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const list = await unwrap(client.api["workflow-definitions"].get()).catch(() => ({
    definitions: [] as Array<{
      workflowId: string;
      name?: string;
      description?: string;
      tags?: string[];
      status?: string;
      owner?: string;
      updatedBy?: string;
      updatedAt?: number;
    }>,
  }));
  return <WorkflowList definitions={list.definitions} />;
}

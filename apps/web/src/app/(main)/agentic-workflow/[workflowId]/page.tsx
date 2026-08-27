import { parseEnv } from "@chengchenccc/config";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { AgenticWorkflowEditor } from "@/components/workflow/AgenticWorkflowEditor";
import { createServerClient, unwrap } from "@/lib/client";

export default async function AgenticWorkflowDetailPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const row = await unwrap(client.api["workflow-definitions"]({ workflowId }).get()).catch(
    () => null,
  );
  const definition = (row as { definition?: WorkflowDefinition } | null)?.definition ?? null;
  return <AgenticWorkflowEditor workflowId={workflowId} initial={definition} />;
}

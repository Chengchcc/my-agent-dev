import { parseEnv } from "@chengchenccc/config";
import { ExecutionList } from "@/components/workflow/ExecutionList";
import { createServerClient, unwrap } from "@/lib/client";

export const dynamic = "force-dynamic";

export default async function ExecutionsPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const list = await unwrap(client.api["workflow-executions"].get({ query: { workflowId } })).catch(
    () => ({
      executions: [] as Array<{
        executionId: string;
        status: string;
        exit?: string;
        createdAt: number;
      }>,
    }),
  );
  const definition = await unwrap(client.api["workflow-definitions"]({ workflowId }).get()).catch(
    () => null,
  );
  return (
    <ExecutionList
      workflowId={workflowId}
      executions={list.executions}
      definition={definition?.definition ?? null}
    />
  );
}

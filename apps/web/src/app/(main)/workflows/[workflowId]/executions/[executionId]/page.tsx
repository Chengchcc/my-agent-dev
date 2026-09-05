import { parseEnv } from "@chengchenccc/config";
import { ExecutionTraceView } from "@/components/workflow/ExecutionTraceView";
import { createServerClient, unwrap } from "@/lib/client";

export default async function ExecutionTracePage({
  params,
}: {
  params: Promise<{ workflowId: string; executionId: string }>;
}) {
  const { executionId } = await params;
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const trace = await unwrap(client.api["workflow-executions"]({ executionId }).trace.get()).catch(
    () => null,
  );
  if (!trace) return <div className="p-8 text-muted-foreground">Execution not found.</div>;
  return (
    <ExecutionTraceView
      execution={trace.execution}
      events={trace.events}
      nodeRuns={trace.nodeRuns}
      pendingHuman={trace.pendingHuman}
    />
  );
}

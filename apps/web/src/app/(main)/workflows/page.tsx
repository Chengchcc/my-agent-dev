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
  // Attach the most recent execution to each workflow for a business-focused list.
  const withLastRun = await Promise.all(
    list.definitions.map(async (d) => {
      const execs = await unwrap(
        client.api["workflow-executions"].get({ query: { workflowId: d.workflowId } }),
      ).catch(() => ({
        executions: [] as Array<{
          executionId: string;
          status: string;
          createdAt: number;
          terminalAt?: number;
          error?: string;
        }>,
      }));
      return {
        ...d,
        lastExecution: execs.executions?.[0] as
          | {
              executionId: string;
              status: string;
              createdAt: number;
              terminalAt?: number;
              error?: string;
            }
          | undefined,
      };
    }),
  );
  return <WorkflowList definitions={withLastRun} />;
}

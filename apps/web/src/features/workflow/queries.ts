import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** U4 (UX audit): surfaces human gates across every workflow execution.
 *  One list call per 30s; the nav badge reads waiting_human count. */
export function waitingGatesQuery() {
  return queryOptions({
    queryKey: ["workflow-executions-gates"],
    queryFn: () => api.listWorkflowExecutions(),
    refetchInterval: 30_000,
    select: (data) => (data.executions ?? []).filter((e) => e.status === "waiting_human").length,
  });
}

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { projectKeys } from "./query-keys";

export function projectListQuery() {
  return queryOptions({
    queryKey: projectKeys.all,
    queryFn: () => api.listProjects(),
  });
}

export function projectDetailQuery(projectId: string) {
  return queryOptions({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
}

export function projectWorktreesQuery(projectId: string) {
  return queryOptions({
    queryKey: projectKeys.worktrees(projectId),
    queryFn: () => api.listProjectWorktrees(projectId),
  });
}

export function projectWorktreeDiffQuery(projectId: string, agentId: string) {
  return queryOptions({
    queryKey: projectKeys.worktreeDiff(projectId, agentId),
    queryFn: () => api.projectWorktreeDiff(projectId, agentId),
  });
}

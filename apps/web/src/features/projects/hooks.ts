import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  projectDetailQuery,
  projectListQuery,
  projectWorktreeDiffQuery,
  projectWorktreesQuery,
} from "./queries";
import { projectKeys } from "./query-keys";

export function useProjectList() {
  return useQuery(projectListQuery());
}

export function useProjectDetail(projectId: string) {
  return useQuery(projectDetailQuery(projectId));
}

export function useProjectWorktrees(projectId: string) {
  return useQuery(projectWorktreesQuery(projectId));
}

export function useProjectWorktreeDiff(projectId: string, agentId: string, enabled: boolean) {
  return useQuery({ ...projectWorktreeDiffQuery(projectId, agentId), enabled });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createProject>[0]) => api.createProject(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateProject>[1] }) =>
      api.updateProject(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export { projectKeys } from "./query-keys";

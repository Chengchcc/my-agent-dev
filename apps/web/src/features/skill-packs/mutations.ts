import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { skillPackKeys } from "./query-keys";

export function useInstallGitPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description: string;
      url: string;
      ref?: string;
      keepSynced?: boolean;
    }) => api.installSkillPackGit(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useUploadZipPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description: string; file: File }) =>
      api.uploadSkillPackZip(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useSyncPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm?: boolean }) =>
      api.syncSkillPack(id, confirm),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useDeletePack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkillPack(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillPackKeys.list() }),
  });
}

export function useSetAgentPacks(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packIds: string[]) => api.setAgentSkillPacks(agentId, { packIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillPackKeys.agentPacks(agentId) });
      queryClient.invalidateQueries({ queryKey: skillPackKeys.list() });
    },
  });
}

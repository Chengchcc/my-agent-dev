import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { artifactsQuery } from "./queries";
import { artifactKeys } from "./query-keys";

export function useArtifacts() {
  return useQuery(artifactsQuery());
}

export function useUploadArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.uploadArtifact,
    onSuccess: () => qc.invalidateQueries({ queryKey: artifactKeys.all }),
  });
}

export function useDeleteArtifact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteArtifact,
    onSuccess: () => qc.invalidateQueries({ queryKey: artifactKeys.all }),
  });
}

export { artifactKeys } from "./query-keys";

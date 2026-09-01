import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { artifactKeys } from "./query-keys";

export function artifactsQuery() {
  return queryOptions({
    queryKey: artifactKeys.all,
    queryFn: () => api.listArtifacts(),
  });
}

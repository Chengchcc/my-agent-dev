import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { providerKeys } from "./query-keys";

export function providersQuery() {
  return queryOptions({
    queryKey: providerKeys.all,
    queryFn: api.listProviders,
  });
}

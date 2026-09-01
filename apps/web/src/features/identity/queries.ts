import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { identityKeys } from "./query-keys";

export function currentUserQuery() {
  return queryOptions({
    queryKey: identityKeys.session,
    queryFn: api.currentUser,
  });
}

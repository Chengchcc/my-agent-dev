import { useQuery } from "@tanstack/react-query";
import { currentUserQuery } from "./queries";

export function useCurrentUser() {
  return useQuery(currentUserQuery());
}

export { identityKeys } from "./query-keys";

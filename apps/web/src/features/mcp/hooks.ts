import { useQuery } from "@tanstack/react-query";
import { mcpCatalogQuery } from "./queries";

export function useMcpCatalog() {
  return useQuery(mcpCatalogQuery());
}

export { mcpKeys } from "./query-keys";

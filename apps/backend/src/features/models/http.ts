import { Elysia } from "elysia";

export interface ModelsCatalog {
  list(): Promise<Array<{ id: string; name: string; available?: boolean }>>;
}

export function modelRoutes(catalog: ModelsCatalog) {
  return new Elysia().get("/api/models", async () => {
    const models = await catalog.list();
    return {
      providers: [{ id: "coding_agent", name: "Coding Agent", models }],
    };
  });
}

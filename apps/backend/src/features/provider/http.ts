import { Elysia, t } from "elysia";
import type { ProviderService } from "./service.js";

export function providerRoutes(svc: ProviderService, opts: { onChange?: () => void } = {}) {
  return new Elysia()
    .get("/api/providers", () => ({ providers: svc.list() }))
    .put(
      "/api/providers/:id",
      ({ params: { id }, body }) => {
        const provider = svc.set(id, body);
        opts.onChange?.();
        return { ok: true, provider };
      },
      {
        body: t.Object({
          apiKey: t.Optional(t.String()),
          baseUrl: t.Optional(t.String()),
        }),
      },
    )
    .delete("/api/providers/:id", ({ params: { id } }) => {
      svc.clear(id);
      opts.onChange?.();
      return { ok: true };
    });
}

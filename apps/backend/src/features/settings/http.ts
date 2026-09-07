import { Elysia, t } from "elysia";
import { DomainError } from "../../infra/domain-errors.js";
import type { SettingsService } from "./service.js";
import { isSecretKey } from "./service.js";

export function settingsRoutes(svc: SettingsService) {
  return new Elysia()
    .get("/api/settings", () => ({ settings: svc.getAll() }))
    .get("/api/settings/system", () => svc.getSystemInfo())
    .put(
      "/api/settings/:key",
      ({ params: { key }, body }) => {
        // Provider credentials have a dedicated channel (PUT /api/providers/:id)
        // and secret-shaped keys must never be written raw through the generic
        // KV route (H5).
        if (key.startsWith("provider.") || isSecretKey(key)) {
          throw new DomainError(`settings key "${key}" is not writable via this route`, 400);
        }
        svc.set(key, body.value);
        return { ok: true, key, value: body.value };
      },
      {
        body: t.Object({ value: t.Unknown() }),
      },
    );
}

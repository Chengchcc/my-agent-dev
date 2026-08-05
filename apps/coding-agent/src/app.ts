import type { ModelRuntime } from "@my-agent-team/ai";
import { Elysia } from "elysia";
import type { CodingAgentConfig } from "./config.js";
import { buildBackendModelCatalog } from "./model-catalog.js";
import { createRoutes } from "./routes.js";
import { type CodingRunRegistry, createCodingRunRegistry } from "./run-registry.js";
import { registerBuiltinProviders } from "./run-runtime.js";

export interface CodingAgentAppDeps {
  config: CodingAgentConfig;
  modelRuntime: ModelRuntime;
  registry?: CodingRunRegistry;
}

export interface CodingAgentApp {
  fetch: (request: Request) => Promise<Response> | Response;
  registry: CodingRunRegistry;
  stop(): Promise<void>;
}

export function createCodingAgentApp(deps: CodingAgentAppDeps): CodingAgentApp {
  // Single provider assembly: the daemon catalog (/v1/models) and the in-
  // process Run loops must agree on which models exist. Register built-ins
  // from the same env the loops receive, so the catalog is not empty when
  // credentials exist.
  registerBuiltinProviders(deps.modelRuntime, deps.config.providerEnv);
  const registry =
    deps.registry ??
    createCodingRunRegistry({
      workspaceRoots: deps.config.workspaceRoots,
      eventBufferSize: deps.config.eventBufferSize,
      modelRuntime: deps.modelRuntime,
    });

  const app = new Elysia().use(
    createRoutes({
      registry,
      authToken: deps.config.authToken,
      getModelCatalog: () => buildBackendModelCatalog({ modelRuntime: deps.modelRuntime }),
    }),
  );

  return {
    fetch: (request) => app.handle(request),
    registry,
    async stop() {
      await registry.shutdown();
    },
  };
}

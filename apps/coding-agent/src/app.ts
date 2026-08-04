import type { ModelRuntime } from "@my-agent-team/ai";
import { Elysia } from "elysia";
import type { CodingAgentConfig } from "./config.js";
import { buildBackendModelCatalog } from "./model-catalog.js";
import { createRoutes } from "./routes.js";
import {
  type CodingSessionSupervisor,
  createCodingSessionSupervisor,
} from "./session-supervisor.js";
import { registerBuiltinProviders } from "./worker-runtime.js";

export interface CodingAgentAppDeps {
  config: CodingAgentConfig;
  modelRuntime: ModelRuntime;
  supervisor?: CodingSessionSupervisor;
}

export interface CodingAgentApp {
  fetch: (request: Request) => Promise<Response> | Response;
  supervisor: CodingSessionSupervisor;
  stop(): Promise<void>;
}

export function createCodingAgentApp(deps: CodingAgentAppDeps): CodingAgentApp {
  // Single provider assembly: the daemon catalog (/v1/models) and the Workers
  // must agree on which models exist. Register built-ins from the same env the
  // Workers receive, so the catalog is not empty when credentials exist.
  registerBuiltinProviders(deps.modelRuntime, deps.config.providerEnv);
  const supervisor =
    deps.supervisor ??
    createCodingSessionSupervisor({
      workerEntry: `${import.meta.dir}/worker-main.ts`,
      cwd: process.cwd(),
      sessionsDir: deps.config.sessionsDir,
      authEnv: { ...deps.config.providerEnv },
      eventBufferSize: deps.config.eventBufferSize,
      workerStopGraceMs: deps.config.workerStopGraceMs,
      acceptTimeoutMs: deps.config.acceptTimeoutMs,
      idleTimeoutMs: deps.config.idleTimeoutMs,
      reapIntervalMs: deps.config.reapIntervalMs,
      workspaceRoots: deps.config.workspaceRoots,
      maxStartingWorkers: deps.config.maxStartingWorkers,
      modelRuntime: deps.modelRuntime,
    });

  const app = new Elysia().use(
    createRoutes({
      supervisor,
      authToken: deps.config.authToken,
      getModelCatalog: () => buildBackendModelCatalog({ modelRuntime: deps.modelRuntime }),
    }),
  );

  return {
    fetch: (request) => app.handle(request),
    supervisor,
    async stop() {
      await supervisor.shutdown();
    },
  };
}

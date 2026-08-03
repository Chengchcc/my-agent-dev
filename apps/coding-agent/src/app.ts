import type { ModelRuntime } from "@my-agent-team/ai";
import { Elysia } from "elysia";
import type { CodingAgentConfig } from "./config.js";
import { buildBackendModelCatalog } from "./model-catalog.js";
import { createRoutes } from "./routes.js";
import {
  type CodingSessionSupervisor,
  createCodingSessionSupervisor,
} from "./session-supervisor.js";

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
  const supervisor =
    deps.supervisor ??
    createCodingSessionSupervisor({
      workerEntry: `${import.meta.dir}/worker-main.ts`,
      cwd: process.cwd(),
      sessionsDir: deps.config.sessionsDir,
      authEnv: {},
      eventBufferSize: deps.config.eventBufferSize,
      workerStopGraceMs: deps.config.workerStopGraceMs,
      idleTimeoutMs: deps.config.idleTimeoutMs,
      reapIntervalMs: deps.config.reapIntervalMs,
      workspaceRoot: deps.config.workspaceRoots[0]!,
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

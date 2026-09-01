import { Elysia } from "elysia";
import type { agentRoutes } from "./features/agent/http.js";
import type { agentRunRoutes } from "./features/agent-run/http.js";
import type { artifactRoutes } from "./features/artifact/http.js";
import type { conversationRoutes } from "./features/conversation/http.js";
import type { knowledgeRoutes } from "./features/knowledge/http.js";
import type { mcpRoutes } from "./features/mcp/http.js";
import type { modelRoutes } from "./features/models/http.js";
import type { projectRoutes } from "./features/project/http.js";
import type { providerRoutes } from "./features/provider/http.js";
import type { opsRoutes } from "./features/runtime-ops/http.js";
import type { settingsRoutes } from "./features/settings/http.js";
import type { skillPackRoutes } from "./features/skill-pack/http.js";
import type { workflowRoutes } from "./features/workflow/http.js";
import { checkAuthToken } from "./infra/auth.js";
import { DomainError } from "./infra/domain-errors.js";
import { HttpError } from "./infra/errors.js";
export interface FeatureSet {
  agents: ReturnType<typeof agentRoutes>;
  conversations: ReturnType<typeof conversationRoutes>;
  ops: ReturnType<typeof opsRoutes>;
  projects: ReturnType<typeof projectRoutes>;
  agentRuns: ReturnType<typeof agentRunRoutes>;
  skillPacks: ReturnType<typeof skillPackRoutes>;
  mcp: ReturnType<typeof mcpRoutes>;
  knowledge: ReturnType<typeof knowledgeRoutes>;
  settings: ReturnType<typeof settingsRoutes>;
  providers: ReturnType<typeof providerRoutes>;
  models: ReturnType<typeof modelRoutes>;
  workflowExecutions: ReturnType<typeof workflowRoutes>;
  artifacts: ReturnType<typeof artifactRoutes>;
}

// ── Auth plugin ──

function authPlugin(token: string) {
  return new Elysia({ name: "auth" }).onBeforeHandle(({ path, headers, set }) => {
    if (path === "/health") return undefined;
    if (!checkAuthToken(headers["x-auth-token"] ?? "", token)) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
    return undefined;
  });
}

// ── Feature route plugins ──

// ── App factory ──

export function createApp(token: string, features: FeatureSet) {
  const {
    agents,
    conversations,
    ops,
    projects,
    skillPacks,
    mcp,
    knowledge,

    settings,
    providers,
    models,
    agentRuns,
    workflowExecutions,
    artifacts,
  } = features;
  const app = new Elysia()
    .get("/health", () => ({ status: "ok" }))
    .use(authPlugin(token))
    .use(agents)
    .use(conversations)
    .use(ops);

  return app
    .use(agentRuns)
    .use(workflowExecutions)
    .use(artifacts)
    .use(projects)
    .use(skillPacks)
    .use(settings)
    .use(providers)
    .use(mcp)
    .use(knowledge)
    .use(models)
    .onError(({ code, error, set }) => {
      if (error instanceof DomainError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (error instanceof HttpError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === "NOT_FOUND") return { error: "Not found" };
      set.status = 500;
      return { error: "Internal server error" };
    });
}

export type App = ReturnType<typeof createApp>;

import { z } from "zod";

/** Agent portable config — the parsed form of workspace `agent.yml`
 *  (ADR 0020 decision 1: agent.yml is the single source; the DB holds
 *  only the FK anchor + this materialized cache). */

export const agentConfigSchema = z.object({
  schema_version: z.literal("1"),
  enabled: z.boolean(),
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  runtime_config: z.object({
    /** BackendKind: coding_agent | claude_code | pi | omp. */
    runtime: z.string().min(1),
    model_id: z.string().min(1),
    reasoning_effort: z.union([z.enum(["none", "low", "high", "max"]), z.literal("")]),
    permission_mode: z.enum(["ask", "auto", "deny"]),
    max_steps: z.number().int().nonnegative(),
    /** Per-agent resource switches (ADR 0022, file-first). */
    mcp_servers: z
      .array(z.object({ server_id: z.string().min(1), enabled: z.boolean() }))
      .default([]),
    knowledge_packs: z.array(z.string()).default([]),
    /** Attached projects (ADR 0023): each materializes a worktree. */
    projects: z.array(z.string().min(1)).default([]),
  }),
  lark: z.object({
    enabled: z.boolean(),
    app_id: z.string(),
    bot_display_name: z.string(),
    /** Server-generated (Lark profile init); backend writes it back. */
    profile_ref: z.string(),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Build the canonical config from the API input shape. Missing fields
 *  fall back to `prev` (update) or defaults (create). */
export function buildAgentConfig(input: {
  id: string;
  name?: string;
  model?: { provider: string; model: string };
  backendKind?: string;
  reasoningEffort?: string | null;
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
  lark?: {
    enabled?: boolean;
    appId?: string;
    botDisplayName?: string;
  };
  prev?: AgentConfig;
}): AgentConfig {
  const prev = input.prev;
  const runtime = input.backendKind ?? prev?.runtime_config.runtime ?? "coding_agent";
  const modelId = input.model
    ? `${input.model.provider}/${input.model.model}`
    : (prev?.runtime_config.model_id ?? "unconfigured/none");
  return agentConfigSchema.parse({
    schema_version: "1",
    enabled: prev?.enabled ?? true,
    id: input.id,
    name: input.name ?? prev?.name ?? input.id,
    title: input.name ?? prev?.title ?? prev?.name ?? input.id,
    description: prev?.description ?? "",
    runtime_config: {
      runtime,
      model_id: modelId,
      reasoning_effort:
        input.reasoningEffort !== undefined
          ? (input.reasoningEffort ?? "")
          : (prev?.runtime_config.reasoning_effort ?? ""),
      permission_mode: input.permissionMode ?? prev?.runtime_config.permission_mode ?? "ask",
      max_steps: input.maxSteps ?? prev?.runtime_config.max_steps ?? 0,
      mcp_servers:
        input.mcpServers?.map((s) => ({ server_id: s.serverId, enabled: s.enabled })) ??
        prev?.runtime_config.mcp_servers ??
        [],
      knowledge_packs: input.knowledgePacks ?? prev?.runtime_config.knowledge_packs ?? [],
      projects: input.projects ?? prev?.runtime_config.projects ?? [],
    },
    lark: {
      enabled: input.lark?.enabled ?? prev?.lark.enabled ?? false,
      app_id: input.lark?.appId ?? prev?.lark.app_id ?? "",
      bot_display_name: input.lark?.botDisplayName ?? prev?.lark.bot_display_name ?? "",
      profile_ref: prev?.lark.profile_ref ?? (input.lark?.enabled ? `agent:${input.id}` : ""),
    },
  });
}

/** Serialize the config to the workspace `agent.yml` format (fixed shape,
 *  JSON-string-quoted values — valid YAML). The backend is the only writer
 *  today; manual edits are picked up by a future file-watch (ADR 0020). */
export function serializeAgentYaml(config: AgentConfig): string {
  const rc = config.runtime_config;
  const lk = config.lark;
  const q = JSON.stringify;
  return [
    "# agent.yml — agent 便携配置的唯一真源(DB 只存锚点 + 缓存)",
    'schema_version: "1"',
    `enabled: ${config.enabled}`,
    `id: ${q(config.id)}`,
    `name: ${q(config.name)}`,
    `title: ${q(config.title)}`,
    `description: ${q(config.description)}`,
    "runtime_config:",
    `  runtime: ${q(rc.runtime)}`,
    `  model_id: ${q(rc.model_id)}`,
    `  reasoning_effort: ${q(rc.reasoning_effort)}`,
    `  permission_mode: ${q(rc.permission_mode)}`,
    `  max_steps: ${rc.max_steps}`,
    "  mcp_servers:",
    ...rc.mcp_servers.map((s) => `    - server_id: ${q(s.server_id)}\n      enabled: ${s.enabled}`),
    "  knowledge_packs:",
    ...rc.knowledge_packs.map((p) => `    - ${q(p)}`),
    "  projects:",
    ...rc.projects.map((p) => `    - ${q(p)}`),
    "lark:",
    `  enabled: ${lk.enabled}`,
    `  app_id: ${q(lk.app_id)}`,
    `  bot_display_name: ${q(lk.bot_display_name)}`,
    `  profile_ref: ${q(lk.profile_ref)}`,
    "",
  ].join("\n");
}

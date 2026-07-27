import { desc, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// ─── agents ────────────────────────────────────────────────────────
export const agents = sqliteTable(
  "agents",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    template: text(),
    workspacePath: text().notNull().unique(),
    modelProvider: text().notNull(),
    modelName: text().notNull(),
    modelBaseUrl: text(),
    permissionMode: text().notNull().default("ask"),
    maxSteps: integer(),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
    archivedAt: integer({ mode: "number" }),
    larkEnabled: integer().notNull().default(0),
    larkAppId: text(),
    larkProfileRef: text(),
    larkBotDisplayName: text(),
  },
  (table) => [index("idx_agents_archived").on(table.archivedAt)],
);

// ─── conversation ──────────────────────────────────────────────────
export const conversation = sqliteTable("conversation", {
  conversationId: text().primaryKey(),
  triggerMode: text().notNull().default("mention"),
  hopCount: integer().notNull().default(0),
  title: text(),
  origin: text().notNull().default("user"),
  createdAt: integer({ mode: "number" }).notNull(),
  forkSource: text("fork_source"),
  forkFromSeq: integer("fork_from_seq"),
});

// ─── member ────────────────────────────────────────────────────────
export const member = sqliteTable(
  "member",
  {
    memberId: text().notNull(),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    kind: text().notNull(),
    agentId: text(),
    userRef: text(),
    displayName: text(),
    /** Session binding: the Agent sessionId for this (conversation, member).
     *  Null until first agent run; set by conversation feature via createAgentSession(). */
    sessionId: text(),
    joinedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.memberId] }),
    index("idx_member_conv").on(table.conversationId),
  ],
);

// ─── conversation_ledger ───────────────────────────────────────────
export const conversationLedger = sqliteTable(
  "conversation_ledger",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    conversationId: text()
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    senderMemberId: text().notNull(),
    addressedTo: text().notNull().default("[]"),
    kind: text().notNull(),
    content: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
    spanId: text("span_id"),
    undone: integer({ mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    index("idx_ledger_run").on(table.spanId).where(sql`span_id IS NOT NULL`),
  ],
);

// projection_messages table removed — redundant third copy of messages.
// Canonical stores: conversation_ledger (product truth) + checkpoint_messages (framework working state).

// ─── project ───────────────────────────────────────────────────────
export const project = sqliteTable(
  "project",
  {
    projectId: text().primaryKey(),
    name: text().notNull(),
    repoUrl: text(),
    defaultBranch: text(),
    autoOrchestrate: integer().notNull().default(0),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("idx_project_name").on(table.name)],
);

// ─── cron_job (M21) ──────────────────────────────────────────────
export const cronJob = sqliteTable(
  "cron_job",
  {
    cronJobId: text().primaryKey(),
    name: text().notNull(),
    agentId: text().notNull(),
    cronExpr: text().notNull(),
    prompt: text().notNull().default(""),
    enabled: integer().notNull().default(0),
    timeoutMs: integer({ mode: "number" }).notNull().default(0),
    maxRetries: integer({ mode: "number" }).notNull().default(0),
    loopConfigPath: text("loop_config_path"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_cron_job_enabled").on(table.enabled)],
);

// ── Execution-related tables (merged into single-db under S1 storage convergence) ──

export const span = sqliteTable(
  "span",
  {
    spanId: text().primaryKey(),
    sessionId: text().notNull(),
    status: text().notNull().default("running"),
    kind: text().notNull().default("main"),
    parentSpanId: text("parent_span_id"),
    agentId: text().notNull().default(""),
    degradedReason: text(),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [index("idx_span_session").on(table.sessionId, desc(table.startedAt))],
);

export const attempt = sqliteTable(
  "attempt",
  {
    spanId: text()
      .notNull()
      .references(() => span.spanId, { onDelete: "cascade" }),
    seq: integer().notNull(),
    startedAt: integer({ mode: "number" }).notNull(),
    endedAt: integer({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.spanId, table.seq] }),
    index("idx_attempt_span").on(table.spanId, table.startedAt),
  ],
);

// S4: run_ops_event → control_plane_event rename
export const controlPlaneEvent = sqliteTable(
  "control_plane_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    spanId: text().notNull(),
    attemptSeq: integer(),
    kind: text().notNull(),
    payload: text().notNull().default("{}"),
    traceId: text(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_control_plane_event_span").on(table.spanId, table.seq),
    index("idx_control_plane_event_trace").on(table.traceId, table.seq),
    index("idx_control_plane_event_kind").on(table.kind, desc(table.ts)),
  ],
);

export const spanOrigin = sqliteTable(
  "span_origin",
  {
    spanId: text().primaryKey(),
    conversationId: text().notNull(),
    sourceLedgerSeq: integer().notNull(),
    agentMemberId: text().notNull(),
    surface: text().notNull().default("web"),
    idempotencyKey: text().notNull(),
    issueId: text(),
    cronJobId: text(),
    fromStatus: text().notNull().default(""),
    originKind: text().notNull().default("manual"),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_span_origin_idem").on(table.idempotencyKey),
    index("idx_span_origin_issue").on(table.issueId),
    index("idx_span_origin_cron").on(table.cronJobId),
  ],
);

export const surfaceHealth = sqliteTable(
  "surface_health",
  {
    agentId: text().notNull(),
    surface: text().notNull(),
    status: text().notNull(),
    lastSeenAt: integer({ mode: "number" }),
    payload: text().notNull().default("{}"),
    lastError: text(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.surface] })],
);

// ─── skill_pack ─────────────────────────────────────────────────────────
export const skillPack = sqliteTable(
  "skill_pack",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    sourceKind: text().notNull(),
    sourceUrl: text(),
    versionRef: text(),
    installedRef: text(),
    status: text().notNull(),
    error: text(),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_skill_pack_status").on(table.status)],
);

// ─── agent_skill_pack ────────────────────────────────────────────────────
export const agentSkillPack = sqliteTable(
  "agent_skill_pack",
  {
    agentId: text().notNull(),
    packId: text().notNull(),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.packId] })],
);

// ─── loop_item ───
export const loopItem = sqliteTable(
  "loop_item",
  {
    loopId: text("loop_id").notNull(),
    itemId: text("item_id").notNull(),
    source: text().notNull(),
    summary: text().notNull(),
    step: text().notNull(),
    attempt: integer().notNull(),
    priority: integer().notNull(),
    result: text(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.loopId, table.itemId] }),
    index("idx_loop_item_step").on(table.loopId, table.step),
  ],
);

// ─── loop_budget ───
export const loopBudget = sqliteTable(
  "loop_budget",
  {
    loopId: text("loop_id").notNull(),
    day: text().notNull(),
    spent: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.loopId, table.day] })],
);

// ─── settings (KV store for runtime-tunable config) ────────────────
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(), // JSON string
  updatedAt: integer({ mode: "number" }).notNull(),
});

// ─── mcp_server ─────────────────────────────────────────────────────
export const mcpServer = sqliteTable(
  "mcp_server",
  {
    serverId: text("server_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    name: text().notNull(),
    transport: text().notNull(),
    command: text(),
    args: text(),
    env: text(),
    url: text(),
    enabled: integer({ mode: "number" }).notNull().default(1),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_mcp_server_agent").on(table.agentId)],
);

// ─── agent_relationship ─────────────────────────────────────────────
export const agentRelationship = sqliteTable(
  "agent_relationship",
  {
    id: text().primaryKey(),
    fromAgent: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgent: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    relType: text().notNull(), // 'assigns_to' | 'collaborates_with'
    weight: real().notNull().default(1.0),
    instruction: text(),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_rel_unique").on(table.fromAgent, table.toAgent, table.relType),
    index("idx_agent_rel_from").on(table.fromAgent),
    index("idx_agent_rel_to").on(table.toAgent),
  ],
);

// ── Zod schemas (type chain: drizzle table → Zod → z.infer → TS type) ──

import { createSelectSchema } from "drizzle-zod";

// ── Simple tables (drizzle-zod auto-generate) ──

export const spanOriginSelectSchema = createSelectSchema(spanOrigin);
export const agentsSelectSchema = createSelectSchema(agents, {
  larkEnabled: (s) => s.transform((v: number) => v !== 0),
  permissionMode: (s) => s.transform((v) => v as "ask" | "auto" | "deny"),
});
export const conversationSelectSchema = createSelectSchema(conversation);
export const memberSelectSchema = createSelectSchema(member);
export const skillPackSelectSchema = createSelectSchema(skillPack, {
  sourceKind: (s) => s.transform((v) => v as "builtin" | "git" | "zip"),
  status: (s) => s.transform((v) => v as "pending" | "installing" | "ready" | "failed" | "syncing"),
});
export const agentSkillPackSelectSchema = createSelectSchema(agentSkillPack);
export const agentRelationshipSelectSchema = createSelectSchema(agentRelationship, {
  relType: (s) => s.transform((v) => v as "assigns_to" | "collaborates_with"),
});

// ── Tables with JSON/bool columns — drizzle-zod refine callback pattern ──
// callback (schema) => schema.transform(...) adds transforms while preserving drizzle-zod types

export const controlPlaneEventSelectSchema = createSelectSchema(controlPlaneEvent, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const surfaceHealthSelectSchema = createSelectSchema(surfaceHealth, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const conversationLedgerSelectSchema = createSelectSchema(conversationLedger, {
  addressedTo: (s) => s.transform((v: string) => JSON.parse(v) as string[]),
  content: (s) => s.transform((v: string) => JSON.parse(v) as unknown),
  undone: (s) => s.transform((v: number) => v !== 0),
});

export const projectSelectSchema = createSelectSchema(project, {
  autoOrchestrate: (s) => s.transform((v: number) => v !== 0),
});

export const cronJobSelectSchema = createSelectSchema(cronJob, {
  enabled: (s) => s.transform((v: number) => v !== 0),
});

export const mcpServerSelectSchema = createSelectSchema(mcpServer, {
  args: (s) =>
    s.transform((v: string) => {
      try {
        return JSON.parse(v) as string[];
      } catch {
        return [] as string[];
      }
    }),
  env: (s) =>
    s.transform((v: string) => {
      try {
        return JSON.parse(v) as Record<string, string>;
      } catch {
        return {} as Record<string, string>;
      }
    }),
  transport: (s) => s.transform((v: string) => v as "stdio" | "sse"),
  enabled: (s) => s.transform((v: number) => v !== 0),
});

/** Convert boolean to 0|1 for integer columns. Single source of truth
 *  for the bool→int conversion used by adapters. */
export const boolToInt = (v: boolean): number => (v ? 1 : 0);

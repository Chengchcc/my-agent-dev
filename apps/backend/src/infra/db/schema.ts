import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// ─── agents ────────────────────────────────────────────────────────
export const agents = sqliteTable(
  "agents",
  {
    id: text().primaryKey(),
    workspacePath: text().notNull().unique(),
    /** Materialized cache of the parsed workspace `agent.yml` (ADR 0020
     *  decision 1: the file is the single source; content columns are
     *  folded into this JSON). */
    config: text().notNull().default("{}"),
    createdAt: integer({ mode: "number" }).notNull(),
    updatedAt: integer({ mode: "number" }).notNull(),
    archivedAt: integer({ mode: "number" }),
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
  /** Project binding (ADR 0023): runs in this conversation use the
   *  project worktree as cwd. Null = agent workspace (default). */
  projectId: text("project_id").references(() => project.projectId, {
    onDelete: "restrict",
  }),
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
    /** Terminal-commit identity: set on the messages of a completed Agent
     *  Run. Unique per (agent_run_id, message_index) - a run's commit can
     *  never be written twice, even across connections/restarts. */
    agentRunId: text("agent_run_id"),
    /** Ordinal of a committed message within its Run (0-based, canonical
     *  sequence order, ADR 0017). */
    messageIndex: integer({ mode: "number" }).notNull().default(0),
    undone: integer({ mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("idx_ledger_conv").on(table.conversationId, table.seq),
    uniqueIndex("idx_ledger_agent_run_message")
      .on(table.agentRunId, table.messageIndex)
      .where(sql`agent_run_id IS NOT NULL`),
  ],
);

// ─── project ───────────────────────────────────────────────────────
export const project = sqliteTable(
  "project",
  {
    projectId: text().primaryKey(),
    name: text().notNull(),
    repoUrl: text(),
    defaultBranch: text(),
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
// Phase 6: span/attempt/control_plane_event/span_origin dropped — Agent Run is
// the only Product execution identity (agent_run + product_tool_call hold the facts).

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

// ─── knowledge_pack (ADR 0022: install pool only; per-agent switches
//     live in agent.yml - file-first, no assignment table) ────────────
export const knowledgePack = sqliteTable(
  "knowledge_pack",
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
  (table) => [index("idx_knowledge_pack_status").on(table.status)],
);

export const knowledgePackSelectSchema = createSelectSchema(knowledgePack, {
  sourceKind: (s) => s.transform((v) => v as "builtin" | "git" | "zip"),
  status: (s) => s.transform((v) => v as "pending" | "installing" | "ready" | "failed" | "syncing"),
});

// ─── Zod schemas (type chain: drizzle table → Zod → z.infer → TS type) ──

import { createSelectSchema } from "drizzle-zod";

// ── Simple tables (drizzle-zod auto-generate) ──

export const agentsSelectSchema = createSelectSchema(agents);
export const conversationSelectSchema = createSelectSchema(conversation);
export const memberSelectSchema = createSelectSchema(member);
export const skillPackSelectSchema = createSelectSchema(skillPack, {
  sourceKind: (s) => s.transform((v) => v as "builtin" | "git" | "zip"),
  status: (s) => s.transform((v) => v as "pending" | "installing" | "ready" | "failed" | "syncing"),
});
export const agentSkillPackSelectSchema = createSelectSchema(agentSkillPack);

// ── Tables with JSON/bool columns — drizzle-zod refine callback pattern ──
// callback (schema) => schema.transform(...) adds transforms while preserving drizzle-zod types

export const surfaceHealthSelectSchema = createSelectSchema(surfaceHealth, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const conversationLedgerSelectSchema = createSelectSchema(conversationLedger, {
  addressedTo: (s) => s.transform((v: string) => JSON.parse(v) as string[]),
  content: (s) => s.transform((v: string) => JSON.parse(v) as unknown),
  undone: (s) => s.transform((v: number) => v !== 0),
});

export const projectSelectSchema = createSelectSchema(project);

export const cronJobSelectSchema = createSelectSchema(cronJob, {
  enabled: (s) => s.transform((v: number) => v !== 0),
});

/** Convert boolean to 0|1 for integer columns. Single source of truth


 *  for the bool→int conversion used by adapters. */
export const boolToInt = (v: boolean): number => (v ? 1 : 0);

// ─── Phase 1: Agent Context, Branches, Runs, Queue, PendingAction ──────────
// DESTRUCTIVE CLEAN CUTOVER - old session/checkpoint state is intentionally discarded.

// Agent Context Tree: one per (conversation, agent member).
export const agentContextTree = sqliteTable(
  "agent_context_tree",
  {
    treeId: text("tree_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.conversationId, { onDelete: "cascade" }),
    agentMemberId: text("agent_member_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.treeId] }),
    uniqueIndex("idx_context_tree_member").on(table.conversationId, table.agentMemberId),
  ],
);

// Agent Context Entry: append-only tree nodes with parent links.
export const agentContextEntry = sqliteTable(
  "agent_context_entry",
  {
    entryId: text("entry_id").notNull(),
    treeId: text("tree_id")
      .notNull()
      .references(() => agentContextTree.treeId, { onDelete: "cascade" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referencing FK requires any
    parentId: text("parent_id").references((): any => agentContextEntry.entryId),
    type: text().notNull(), // ledger_message | private_message | product_tool_exchange | summary | model_change
    payload: text().notNull(), // JSON: type-specific payload
    ledgerSeq: integer("ledger_seq"), // only for ledger_message
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId] }),
    index("idx_context_entry_tree").on(table.treeId, table.parentId),
    index("idx_context_entry_leaf").on(table.treeId, table.entryId),
  ],
);

// Context Branch: a path from root to a leaf entry.
export const agentContextBranch = sqliteTable(
  "agent_context_branch",
  {
    branchId: text("branch_id").notNull(),
    treeId: text("tree_id")
      .notNull()
      .references(() => agentContextTree.treeId, { onDelete: "cascade" }),
    leafEntryId: text("leaf_entry_id"),
    ledgerCursor: integer("ledger_cursor").notNull().default(0),
    backendKind: text("backend_kind").notNull(),
    /** CLI session reference (ADR 0002): claude session_id or pi/omp
     *  session file path — the CLI-side runtime truth for context
     *  continuation. Null until the first CLI-backed run on the branch. */
    cliSessionRef: text("cli_session_ref"),
    isDefault: integer("is_default", { mode: "number" }).notNull().default(0),
    revision: integer().notNull().default(1),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId] }),
    // One default branch per tree (partial unique index).
    uniqueIndex("idx_context_branch_default").on(table.treeId).where(sql`is_default = 1`),
    index("idx_context_branch_tree").on(table.treeId),
  ],
);

// Agent Run: product execution identity.
export const agentRun = sqliteTable(
  "agent_run",
  {
    runId: text("run_id").notNull(),
    branchId: text("branch_id")
      .notNull()
      .references(() => agentContextBranch.branchId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    agentMemberId: text("agent_member_id").notNull(),
    modelRef: text("model_ref").notNull(), // JSON: BackendModelRef
    status: text().notNull().default("running"), // running|waiting|commit_failed|completed|failed|aborted|timeout
    idempotencyKey: text("idempotency_key").notNull(),
    terminalResult: text("terminal_result"), // JSON: serialized BackendRunOutcome, set on terminal
    configRevision: integer("config_revision").notNull(),
    /** Run-level workspace snapshot: root + access. Null = resolve from the
     *  agent member record at dispatch. */
    workspaceRoot: text("workspace_root"),
    workspaceAccess: text("workspace_access"),
    /** JSON: the run's Product Tool manifest (ProductToolDescriptor[]),
     *  written at first dispatch; Product Tools MCP validates against it. */
    productTools: text("product_tools"),
    /** Frozen system prompt (Agent identity for Conversation/Cron runs;
     *  LOOP.md generator/evaluator prompt for Loop runs). Null = none. */
    systemPrompt: text("system_prompt"),
    /** JSON: frozen skill pack roots (absolute dirs scanned for SKILL.md). */
    skillRoots: text("skill_roots"),
    /** Frozen permission_mode (ask/auto/deny), mapped per backend at
     *  dispatch (ADR 0020 decision 7; claude --permission-mode). */
    permissionMode: text("permission_mode"),
    /** JSON: the run's latest task list snapshot (todo_write product tool).
     *  Re-injected into the next run's prompt as the Current Tasks section. */
    todoSnapshot: text("todo_snapshot"),
    /** Optional workflow budget (tokens): the Loop freezes the remaining
     *  daily budget at dispatch; the child gates subagent spawns on it. */
    workflowBudgetTokens: integer("workflow_budget_tokens"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId] }),
    uniqueIndex("idx_agent_run_idempotency").on(table.idempotencyKey),
    // Single active run per branch: partial unique index on active statuses.
    uniqueIndex("idx_agent_run_active_branch")
      .on(table.branchId)
      .where(sql`status IN ('running', 'waiting', 'commit_failed')`),
    index("idx_agent_run_branch").on(table.branchId),
  ],
);

// Branch Input Queue: durable normal/steer/follow_up inputs.
export const branchInputQueue = sqliteTable(
  "branch_input_queue",
  {
    /** Monotonic insertion order (the real queue sequence): the sort key for
     *  claim/recover/list. Never derived from timestamps or random ids. */
    seq: integer().primaryKey({ autoIncrement: true }),
    inputId: text("input_id").notNull().unique(),
    branchId: text("branch_id")
      .notNull()
      .references(() => agentContextBranch.branchId, { onDelete: "cascade" }),
    mode: text().notNull(), // normal | steer | follow_up
    message: text().notNull(), // JSON: serialized Message
    status: text().notNull().default("pending"), // pending | delivering | delivered | cancelled
    deliveryIdempotencyKey: text("delivery_idempotency_key").notNull(),
    inputIdempotencyKey: text("input_idempotency_key").notNull(),
    runId: text("run_id"), // set when acquired
    /** Request-time Run config snapshot (JSON BackendModelRef). Persisted on
     *  the queue row so a later promote (acquireNextRun) uses THIS input's
     *  snapshot, never the previous Run's config. */
    modelRef: text("model_ref"),
    configRevision: integer("config_revision"),
    workspaceRoot: text("workspace_root"),
    workspaceAccess: text("workspace_access"),
    systemPrompt: text("system_prompt"),
    skillRoots: text("skill_roots"), // JSON: readonly string[]
    permissionMode: text("permission_mode"),
    /** Optional workflow budget (tokens), frozen at enqueue; the child
     *  gates workflow subagent spawns on it. */
    workflowBudgetTokens: integer("workflow_budget_tokens"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("idx_queue_delivery_idem").on(table.deliveryIdempotencyKey),
    uniqueIndex("idx_queue_input_idem").on(table.branchId, table.inputIdempotencyKey),
    // Stable queue ordering: branch + monotonic seq.
    index("idx_queue_order").on(table.branchId, table.seq),
  ],
);

// Pending Action: approval/question awaiting a response.
export const pendingAction = sqliteTable(
  "pending_action",
  {
    actionId: text("action_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.runId, { onDelete: "cascade" }),
    kind: text().notNull(),
    payload: text().notNull(), // JSON
    status: text().notNull().default("pending"), // pending | resolved | cancelled
    response: text(), // JSON: PendingActionResponse
    responseIdempotencyKey: text("response_idempotency_key"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.actionId] }),
    uniqueIndex("idx_pending_action_response_idem").on(table.responseIdempotencyKey),
    index("idx_pending_action_run").on(table.runId),
  ],
);

// Product Tool Call: durable idempotency + audit for SEMANTIC MUTATION calls
// (e.g. history_retain). Read-only tools never write here. One row per
// (runId, callId); replay returns the stored result, conflicting input fails.
export const productToolCall = sqliteTable(
  "product_tool_call",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.runId, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text().notNull().default("completed"), // completed | failed
    result: text(), // JSON: standardized tool result
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    completedAt: integer("completed_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.callId] }),
    index("idx_product_tool_call_run").on(table.runId),
  ],
);

// ── Phase 1 select schemas (JSON/bool columns need transform pattern) ──

export const agentContextEntrySelectSchema = createSelectSchema(agentContextEntry, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const agentContextBranchSelectSchema = createSelectSchema(agentContextBranch, {
  isDefault: (s) => s.transform((v: number) => v !== 0),
});

export const agentRunSelectSchema = createSelectSchema(agentRun, {
  modelRef: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
  terminalResult: (s) =>
    s.transform((v: string | null) => (v ? (JSON.parse(v) as Record<string, unknown>) : null)),
});

export const branchInputQueueSelectSchema = createSelectSchema(branchInputQueue, {
  message: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
});

export const pendingActionSelectSchema = createSelectSchema(pendingAction, {
  payload: (s) => s.transform((v: string) => JSON.parse(v) as Record<string, unknown>),
  response: (s) =>
    s.transform((v: string | null) => (v ? (JSON.parse(v) as Record<string, unknown>) : null)),
});

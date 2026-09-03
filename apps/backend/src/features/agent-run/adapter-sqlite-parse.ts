import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import type * as schema from "../../infra/db/schema.js";
import type { AgentRun, BranchInput, PendingActionRecord } from "./domain.js";

export function parseModelRef(json: string): AgentRun["modelRef"] {
  return JSON.parse(json) as AgentRun["modelRef"];
}

export function parseRun(row: typeof schema.agentRun.$inferSelect): AgentRun {
  return {
    runId: row.runId,
    branchId: row.branchId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    modelRef: parseModelRef(row.modelRef),
    status: row.status as AgentRun["status"],
    idempotencyKey: row.idempotencyKey,
    terminalResult: row.terminalResult
      ? (JSON.parse(row.terminalResult) as BackendRunOutcome)
      : null,
    configRevision: row.configRevision,
    workspace:
      row.workspaceRoot && row.workspaceAccess
        ? { root: row.workspaceRoot, access: row.workspaceAccess as "read_only" | "read_write" }
        : null,
    productTools: row.productTools
      ? (JSON.parse(row.productTools) as AgentRun["productTools"])
      : null,
    systemPrompt: row.systemPrompt,
    skillRoots: row.skillRoots ? (JSON.parse(row.skillRoots) as string[]) : null,
    permissionMode: row.permissionMode,
    todoSnapshot: row.todoSnapshot,
    workflowBudgetTokens: row.workflowBudgetTokens,
    workflow: row.workflow ? (JSON.parse(row.workflow) as AgentRun["workflow"]) : null,
    createdAt: row.createdAt,
    terminalAt: row.terminalAt,
  };
}

export function parseInput(row: typeof schema.branchInputQueue.$inferSelect): BranchInput {
  return {
    inputId: row.inputId,
    seq: row.seq,
    branchId: row.branchId,
    mode: row.mode as BranchInput["mode"],
    message: JSON.parse(row.message) as BranchInput["message"],
    status: row.status as BranchInput["status"],
    deliveryIdempotencyKey: row.deliveryIdempotencyKey,
    inputIdempotencyKey: row.inputIdempotencyKey,
    runId: row.runId,
    configSnapshot: {
      modelRef: row.modelRef
        ? (JSON.parse(row.modelRef) as { backendKind: string; modelId: string })
        : { backendKind: "oma", modelId: "" },
      configRevision: row.configRevision ?? 0,
      workspace:
        row.workspaceRoot && row.workspaceAccess
          ? { root: row.workspaceRoot, access: row.workspaceAccess as "read_only" | "read_write" }
          : null,
      systemPrompt: row.systemPrompt,
      skillRoots: row.skillRoots ? (JSON.parse(row.skillRoots) as string[]) : null,
      permissionMode: row.permissionMode,
      workflowBudgetTokens: row.workflowBudgetTokens,
    },
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

export function parsePendingAction(
  row: typeof schema.pendingAction.$inferSelect,
): PendingActionRecord {
  return {
    actionId: row.actionId,
    runId: row.runId,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as PendingActionRecord["status"],
    response: row.response ? JSON.parse(row.response) : null,
    responseIdempotencyKey: row.responseIdempotencyKey,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

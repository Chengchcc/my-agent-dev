import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { workflowExecution, workflowNodeRun, workflowPendingHuman } from "../../infra/db/schema.js";
import type {
  AppendNodeRunInput,
  CreateWorkflowExecutionInput,
  WorkflowExecutionRow,
  WorkflowNodeRunRow,
  WorkflowPendingHumanRow,
} from "./domain.js";
import type { WorkflowExecutionPort } from "./ports.js";

function toExec(r: typeof workflowExecution.$inferSelect): WorkflowExecutionRow {
  return {
    executionId: r.executionId,
    workflowId: r.workflowId,
    definition: JSON.parse(r.definition),
    input: JSON.parse(r.input),
    store: JSON.parse(r.store),
    status: r.status as WorkflowExecutionRow["status"],
    exit: r.exit ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

function toNodeRun(r: typeof workflowNodeRun.$inferSelect): WorkflowNodeRunRow {
  return {
    seq: r.seq,
    executionId: r.executionId,
    nodeId: r.nodeId,
    status: r.status as WorkflowNodeRunRow["status"],
    order: r.order,
    output: r.output ? JSON.parse(r.output) : undefined,
    routedTo: r.routedTo ? JSON.parse(r.routedTo) : undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

function toPending(r: typeof workflowPendingHuman.$inferSelect): WorkflowPendingHumanRow {
  return {
    executionId: r.executionId,
    nodeId: r.nodeId,
    question: r.question ?? undefined,
    form: r.form ? JSON.parse(r.form) : undefined,
    status: r.status as WorkflowPendingHumanRow["status"],
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

export function sqliteWorkflowExecutionAdapter(db: Database): WorkflowExecutionPort {
  const d = drizzle(db, {
    schema: { workflowExecution, workflowNodeRun, workflowPendingHuman },
    casing: "snake_case",
  });
  return {
    async createExecution(input: CreateWorkflowExecutionInput) {
      const [row] = await d
        .insert(workflowExecution)
        .values({
          executionId: input.executionId,
          workflowId: input.workflowId,
          definition: JSON.stringify(input.definition),
          input: JSON.stringify(input.input),
          store: JSON.stringify(input.store),
          status: input.status ?? "running",
          createdAt: input.createdAt ?? Date.now(),
        })
        .returning();
      return toExec(row!);
    },
    async getExecution(executionId) {
      const rows = await d
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.executionId, executionId));
      const r = rows[0];
      return r ? toExec(r) : null;
    },
    async updateExecution(executionId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.exit !== undefined) values.exit = patch.exit;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.store !== undefined) values.store = JSON.stringify(patch.store);
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length > 0) {
        await d
          .update(workflowExecution)
          .set(values)
          .where(eq(workflowExecution.executionId, executionId));
      }
      return this.getExecution(executionId);
    },
    async appendNodeRun(input: AppendNodeRunInput) {
      const [row] = await d
        .insert(workflowNodeRun)
        .values({
          executionId: input.executionId,
          nodeId: input.nodeId,
          status: input.status,
          order: input.order,
          output: input.output ? JSON.stringify(input.output) : null,
          routedTo: input.routedTo ? JSON.stringify(input.routedTo) : null,
          error: input.error ?? null,
          createdAt: input.createdAt ?? Date.now(),
        })
        .returning();
      return toNodeRun(row!);
    },
    async updateNodeRun(executionId, nodeId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.output !== undefined)
        values.output = patch.output ? JSON.stringify(patch.output) : null;
      if (patch.routedTo !== undefined)
        values.routedTo = patch.routedTo ? JSON.stringify(patch.routedTo) : null;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length > 0) {
        await d
          .update(workflowNodeRun)
          .set(values)
          .where(
            and(eq(workflowNodeRun.executionId, executionId), eq(workflowNodeRun.nodeId, nodeId)),
          );
      }
      const rows = await d
        .select()
        .from(workflowNodeRun)
        .where(
          and(eq(workflowNodeRun.executionId, executionId), eq(workflowNodeRun.nodeId, nodeId)),
        );
      const r = rows[0];
      return r ? toNodeRun(r) : null;
    },
    async listNodeRuns(executionId) {
      const rows = await d
        .select()
        .from(workflowNodeRun)
        .where(eq(workflowNodeRun.executionId, executionId))
        .orderBy(workflowNodeRun.seq);
      return rows.map(toNodeRun);
    },
    async createPendingHuman(row) {
      const [r] = await d
        .insert(workflowPendingHuman)
        .values({
          executionId: row.executionId,
          nodeId: row.nodeId,
          question: row.question ?? null,
          form: row.form ? JSON.stringify(row.form) : null,
          status: row.status,
          createdAt: row.createdAt,
        })
        .returning();
      return toPending(r!);
    },
    async getPendingHuman(executionId, nodeId) {
      const rows = await d
        .select()
        .from(workflowPendingHuman)
        .where(
          and(
            eq(workflowPendingHuman.executionId, executionId),
            eq(workflowPendingHuman.nodeId, nodeId),
          ),
        );
      const r = rows[0];
      return r ? toPending(r) : null;
    },
    async markPendingHumanResolved(executionId, nodeId) {
      await d
        .update(workflowPendingHuman)
        .set({ status: "resolved", terminalAt: Date.now() })
        .where(
          and(
            eq(workflowPendingHuman.executionId, executionId),
            eq(workflowPendingHuman.nodeId, nodeId),
          ),
        );
    },
    async listRunningExecutions() {
      const rows = await d
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.status, "running"));
      return rows.map(toExec);
    },
    async listExecutions(workflowId?: string) {
      if (workflowId) {
        const rows = await d
          .select()
          .from(workflowExecution)
          .where(eq(workflowExecution.workflowId, workflowId))
          .orderBy(desc(workflowExecution.createdAt));
        return rows.map(toExec);
      }
      const rows = await d
        .select()
        .from(workflowExecution)
        .orderBy(desc(workflowExecution.createdAt));
      return rows.map(toExec);
    },
    async listWaitingHumanExecutions() {
      const rows = await d
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.status, "waiting_human"));
      return rows.map(toExec);
    },
  };
}

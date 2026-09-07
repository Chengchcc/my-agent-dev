import type {
  AppendNodeRunInput,
  CreateWorkflowExecutionInput,
  WorkflowExecutionRow,
  WorkflowNodeRunRow,
  WorkflowPendingHumanRow,
} from "./domain.js";

export interface WorkflowExecutionPort {
  createExecution(input: CreateWorkflowExecutionInput): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  updateExecution(
    executionId: string,
    patch: Partial<
      Pick<WorkflowExecutionRow, "status" | "exit" | "error" | "store" | "terminalAt">
    >,
  ): Promise<WorkflowExecutionRow | null>;
  appendNodeRun(input: AppendNodeRunInput): Promise<WorkflowNodeRunRow>;
  updateNodeRun(
    executionId: string,
    nodeId: string,
    patch: Partial<
      Pick<WorkflowNodeRunRow, "status" | "output" | "routedTo" | "error" | "terminalAt" | "runId">
    >,
  ): Promise<WorkflowNodeRunRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  createPendingHuman(row: WorkflowPendingHumanRow): Promise<WorkflowPendingHumanRow>;
  getPendingHuman(executionId: string, nodeId: string): Promise<WorkflowPendingHumanRow | null>;
  /** Claims the pending human task atomically: returns false when another
   *  resolver already claimed it (conditional UPDATE on status='pending'). */
  markPendingHumanResolved(executionId: string, nodeId: string): Promise<boolean>;
  appendExecutionEvent(input: {
    executionId: string;
    event: string;
    data: unknown;
    ts: number;
  }): Promise<void>;
  listExecutionEvents(
    executionId: string,
  ): Promise<Array<{ seq: number; executionId: string; event: string; data: unknown; ts: number }>>;
  listRunningExecutions(): Promise<WorkflowExecutionRow[]>;
  listExecutions(workflowId?: string): Promise<WorkflowExecutionRow[]>;
  deleteExecution(executionId: string): Promise<boolean>;
  listWaitingHumanExecutions(): Promise<WorkflowExecutionRow[]>;
  listWaitingHumanExecutions(): Promise<WorkflowExecutionRow[]>;
}

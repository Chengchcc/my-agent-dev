import type { WorkflowDefinition } from "@chengchenccc/workflow";

export type WorkflowExecutionStatus =
  | "running"
  | "waiting_human"
  | "success"
  | "failure"
  | "custom";
export type WorkflowNodeRunStatus = "running" | "waiting_human" | "completed" | "failed";
export type WorkflowPendingHumanStatus = "pending" | "resolved";

export interface WorkflowExecutionRow {
  executionId: string;
  workflowId: string;
  triggeredBy?: string | null;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status: WorkflowExecutionStatus;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
}

export interface WorkflowNodeRunRow {
  seq: number;
  executionId: string;
  nodeId: string;
  runId?: string | null;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt: number;
  terminalAt?: number;
}

export interface WorkflowPendingHumanRow {
  executionId: string;
  nodeId: string;
  question?: string;
  form?: Record<string, unknown>;
  status: WorkflowPendingHumanStatus;
  createdAt: number;
  terminalAt?: number;
}

export interface CreateWorkflowExecutionInput {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status?: WorkflowExecutionStatus;
  triggeredBy?: string | null;
  createdAt?: number;
}

export interface AppendNodeRunInput {
  executionId: string;
  nodeId: string;
  runId?: string | null;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt?: number;
}

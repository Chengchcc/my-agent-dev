// src/tools/todo-write.ts
import { z } from 'zod';
import ZodTool from './zod-tool';
import type { TodoItem, TodoStatus } from '../todos/types';
import type { AgentContext } from '../types';

// In-memory task store for now (will eventually be moved to context)
let taskStore: Array<{
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}> = [];

// Generate a simple unique ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export interface TaskCreateParameters {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskCreateResult {
  taskId: string;
  success: true;
}

const taskCreateSchema = z.object({
  subject: z.string().describe('Brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow").'),
  description: z.string().describe('Detailed description of what needs to be done.'),
  activeForm: z.string().optional().describe('Continuous active form shown when in progress.'),
  metadata: z.record(z.unknown()).optional().describe('Optional metadata to attach to the task.'),
});

export class TaskCreateTool extends ZodTool<typeof taskCreateSchema> {
  name = 'TaskCreate';
  description = 'Create a new structured task to track work progress. Use for complex multi-step tasks to organize work.';
  schema = taskCreateSchema;

  protected handle(params: z.infer<typeof taskCreateSchema>): TaskCreateResult {
    const taskId = generateId();
    taskStore.push({
      id: taskId,
      subject: params.subject,
      description: params.description,
      status: 'pending',
      activeForm: params.activeForm,
      blocks: [],
      blockedBy: [],
      metadata: params.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { taskId, success: true };
  }
}

export interface TaskUpdateParameters {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskUpdateResult {
  success: boolean;
  taskId: string;
}

const taskUpdateSchema = z.object({
  taskId: z.string().describe('ID of the task to update.'),
  subject: z.string().optional().describe('New title for the task.'),
  description: z.string().optional().describe('New description for the task.'),
  activeForm: z.string().optional().describe('New active form.'),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional().describe('New status for the task.'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks.'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task.'),
  owner: z.string().optional().describe('Owner assigned to this task.'),
  metadata: z.record(z.unknown()).optional().describe('Metadata to merge into existing metadata.'),
});

export class TaskUpdateTool extends ZodTool<typeof taskUpdateSchema> {
  name = 'TaskUpdate';
  description = 'Update an existing task (change status, edit details, add dependencies). Mark tasks as completed when done.';
  schema = taskUpdateSchema;

  protected handle(params: z.infer<typeof taskUpdateSchema>): TaskUpdateResult {
    const index = taskStore.findIndex(t => t.id === params.taskId);
    if (index === -1) {
      return { success: false, taskId: params.taskId };
    }

    const task = taskStore[index];
    if (params.subject !== undefined) task.subject = params.subject;
    if (params.description !== undefined) task.description = params.description;
    if (params.activeForm !== undefined) task.activeForm = params.activeForm;
    if (params.status !== undefined) task.status = params.status;
    if (params.addBlocks !== undefined) task.blocks.push(...params.addBlocks);
    if (params.addBlockedBy !== undefined) task.blockedBy.push(...params.addBlockedBy);
    if (params.owner !== undefined) task.owner = params.owner;
    if (params.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...params.metadata };
    }
    task.updatedAt = new Date();

    return { success: true, taskId: params.taskId };
  }
}

export interface TaskGetParameters {
  taskId: string;
}

export interface TaskGetResult {
  task: typeof taskStore[0] | null;
  success: true;
}

const taskGetSchema = z.object({
  taskId: z.string().describe('ID of the task to retrieve.'),
});

export class TaskGetTool extends ZodTool<typeof taskGetSchema> {
  name = 'TaskGet';
  description = 'Retrieve full details of a specific task by ID.';
  schema = taskGetSchema;

  protected handle(params: z.infer<typeof taskGetSchema>): TaskGetResult {
    const task = taskStore.find(t => t.id === params.taskId);
    return { task: task || null, success: true };
  }
}

export interface TaskListResult {
  tasks: Array<{
    id: string;
    subject: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
    owner?: string;
  }>;
  success: true;
}

const taskListSchema = z.object({});

export class TaskListTool extends ZodTool<typeof taskListSchema> {
  name = 'TaskList';
  description = 'List all tasks with their current status. Use to see what work is pending, in progress, or completed.';
  schema = taskListSchema;

  protected handle(): TaskListResult {
    const tasks = taskStore.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner,
    }));
    return { tasks, success: true };
  }
}

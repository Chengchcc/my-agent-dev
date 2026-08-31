/** Lightweight SSE fan-out for workflow-definition changes. Every write
 *  path (HTTP PUT save, workflow MCP workflow_write) emits a "changed"
 *  notification keyed by workflow id. The workflow editor subscribes and
 *  refetches the definition only when something actually changed — no idle
 *  polling. Reuses the queue pattern from ExecutionEventBus. */

export interface WorkflowDefinitionEvent {
  event: "changed";
  workflowId: string;
  ts: number;
  data: { trigger: "save" | "mcp" };
}

class Queue {
  private items: WorkflowDefinitionEvent[] = [];
  private wake: (() => void) | null = null;

  push(ev: WorkflowDefinitionEvent): void {
    this.items.push(ev);
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *consume(): AsyncIterable<WorkflowDefinitionEvent> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift()!;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class WorkflowDefinitionEventBus {
  private queues = new Map<string, Set<Queue>>();

  emit(workflowId: string, data: { trigger: "save" | "mcp" }): void {
    const ev: WorkflowDefinitionEvent = { event: "changed", workflowId, ts: Date.now(), data };
    for (const q of this.queues.get(workflowId) ?? []) q.push(ev);
  }

  subscribe(workflowId: string): AsyncIterable<WorkflowDefinitionEvent> {
    const q = new Queue();
    const set = this.queues.get(workflowId) ?? new Set<Queue>();
    set.add(q);
    this.queues.set(workflowId, set);
    return q.consume();
  }

  dispose(): void {
    this.queues.clear();
  }
}

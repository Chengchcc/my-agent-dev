export interface WorkflowEvent {
  event: string;
  executionId: string;
  ts: number;
  data: unknown;
}

class Queue {
  private items: WorkflowEvent[] = [];
  private wake: (() => void) | null = null;

  push(ev: WorkflowEvent): void {
    this.items.push(ev);
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *consume(): AsyncIterable<WorkflowEvent> {
    for (;;) {
      while (this.items.length > 0) {
        const ev = this.items.shift()!;
        yield ev;
        if (ev.event === "execution_terminal") return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class ExecutionEventBus {
  private queues = new Map<string, Set<Queue>>();

  emit(ev: WorkflowEvent): void {
    for (const q of this.queues.get(ev.executionId) ?? []) q.push(ev);
  }

  subscribe(executionId: string): AsyncIterable<WorkflowEvent> {
    const q = new Queue();
    const set = this.queues.get(executionId) ?? new Set<Queue>();
    set.add(q);
    this.queues.set(executionId, set);
    return q.consume();
  }

  dispose(): void {
    this.queues.clear();
  }
}

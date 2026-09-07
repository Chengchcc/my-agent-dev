export interface WorkflowEvent {
  event: string;
  executionId: string;
  ts: number;
  data: unknown;
}

class Queue {
  private items: WorkflowEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(ev: WorkflowEvent): void {
    if (this.closed) return;
    this.items.push(ev);
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  /** Release a detached consumer (M6): wake the pending await and make
   *  consume() return instead of holding the generator forever. */
  close(): void {
    this.closed = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *consume(): AsyncIterable<WorkflowEvent> {
    for (;;) {
      while (this.items.length > 0) {
        const ev = this.items.shift()!;
        yield ev;
        if (ev.event === "execution_terminal") return;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export interface EventBusSubscription<Ev> {
  stream: AsyncIterable<Ev>;
  /** M6: MUST be called when the consumer stops (client disconnect,
   *  terminal event, error) — dead queues otherwise accumulate forever. */
  unsubscribe(): void;
}

export class ExecutionEventBus {
  private queues = new Map<string, Set<Queue>>();

  emit(ev: WorkflowEvent): void {
    for (const q of this.queues.get(ev.executionId) ?? []) q.push(ev);
  }

  subscribe(executionId: string): EventBusSubscription<WorkflowEvent> {
    const q = new Queue();
    const set = this.queues.get(executionId) ?? new Set<Queue>();
    set.add(q);
    this.queues.set(executionId, set);
    return {
      stream: q.consume(),
      unsubscribe: () => {
        const set = this.queues.get(executionId);
        if (!set) return;
        set.delete(q);
        if (set.size === 0) this.queues.delete(executionId);
        q.close();
      },
    };
  }

  dispose(): void {
    this.queues.clear();
  }
}

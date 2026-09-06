/** Lightweight SSE fan-out for agent-config changes, mirroring the
 *  workflow-definition event bus. Every write path (HTTP PATCH save, agent
 *  MCP agent_write) emits a "changed" notification keyed by agent id. The
 *  agent edit page subscribes and adopts the proposed config when the chat
 *  agent proposes a change (trigger="mcp") — no idle polling. */

export interface AgentConfigEvent {
  event: "changed";
  agentId: string;
  ts: number;
  data: { trigger: "save" | "mcp"; config?: unknown };
}

class Queue {
  private items: AgentConfigEvent[] = [];
  private wake: (() => void) | null = null;

  push(ev: AgentConfigEvent): void {
    this.items.push(ev);
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *consume(): AsyncIterable<AgentConfigEvent> {
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

export class AgentConfigEventBus {
  private queues = new Map<string, Set<Queue>>();

  emit(agentId: string, data: { trigger: "save" | "mcp"; config?: unknown }): void {
    const ev: AgentConfigEvent = { event: "changed", agentId, ts: Date.now(), data };
    for (const q of this.queues.get(agentId) ?? []) q.push(ev);
  }

  subscribe(agentId: string): AsyncIterable<AgentConfigEvent> {
    const q = new Queue();
    const set = this.queues.get(agentId) ?? new Set<Queue>();
    set.add(q);
    this.queues.set(agentId, set);
    return q.consume();
  }

  dispose(): void {
    this.queues.clear();
  }
}

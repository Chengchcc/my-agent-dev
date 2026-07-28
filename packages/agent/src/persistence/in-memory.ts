import type { Message } from "@my-agent-team/message";
import type { Checkpointer } from "./checkpointer.js";
import type { CheckpointEventRow, EventLog } from "./event-log.js";
import type { InterruptState, InterruptStore } from "./interrupt-store.js";
import type { MessageStore } from "./message-store.js";

/** 消息存储 -- 内存实现。 */
export function inMemoryMessageStore(): MessageStore {
  const messages = new Map<string, Message[]>();
  return {
    async load(sessionId) {
      const found = messages.get(sessionId);
      return found ? structuredClone(found) : null;
    },
    async save(sessionId, msgs) {
      messages.set(sessionId, structuredClone([...msgs]));
    },
    async deleteThread(sessionId) {
      messages.delete(sessionId);
    },
  };
}

/** 执行事件日志 -- 内存实现。 */
export function inMemoryEventLog(): EventLog {
  const events = new Map<string, CheckpointEventRow[]>();
  return {
    async appendEvent(sessionId, spanId, event) {
      if (!events.has(sessionId)) events.set(sessionId, []);
      events.get(sessionId)?.push({ ...event, spanId: spanId ?? null, ts: event.ts });
    },
    async *readEvents(sessionId, opts) {
      const all = events.get(sessionId) ?? [];
      for (const e of all) {
        if (opts?.spanId && e.spanId !== opts.spanId) continue;
        yield e;
      }
    },
  };
}

/** 中断状态存储 -- 内存实现。 */
export function inMemoryInterruptStore(): InterruptStore {
  const interrupts = new Map<string, InterruptState>();
  return {
    async saveInterrupt(sessionId, state) {
      interrupts.set(sessionId, state);
    },
    async consumeInterrupt(sessionId) {
      const s = interrupts.get(sessionId);
      interrupts.delete(sessionId);
      return s ?? null;
    },
  };
}

/** 组合 checkpointer -- 三个拆分实现组装为 Checkpointer 复合接口。 */
export function inMemoryCheckpointer(): Checkpointer {
  const messageStore = inMemoryMessageStore();
  const eventLog = inMemoryEventLog();
  const interruptStore = inMemoryInterruptStore();
  return {
    load: messageStore.load.bind(messageStore),
    save: messageStore.save.bind(messageStore),
    deleteThread: messageStore.deleteThread?.bind(messageStore),
    appendEvent: eventLog.appendEvent.bind(eventLog),
    readEvents: eventLog.readEvents.bind(eventLog),
    saveInterrupt: interruptStore.saveInterrupt.bind(interruptStore),
    consumeInterrupt: interruptStore.consumeInterrupt.bind(interruptStore),
  };
}

import type { ToolUseBlock } from "@my-agent-team/core";

export class InterruptSignal extends Error {
  constructor(
    public readonly reason: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`Interrupted: ${reason}`);
    this.name = "InterruptSignal";
  }
}

export interface InterruptState {
  pendingTool: { call: ToolUseBlock; reason: string };
  ts: number;
  meta?: Record<string, unknown>;
}

/** 中断状态存储 -- 工具审批暂停/恢复。 */
export interface InterruptStore {
  saveInterrupt(sessionId: string, state: InterruptState): Promise<void>;
  consumeInterrupt(sessionId: string): Promise<InterruptState | null>;
}

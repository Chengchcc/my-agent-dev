"use client";

import type { WorkflowNode } from "@chengchenccc/workflow";
import { Bot, Code2, Flag, UserRound, X } from "lucide-react";

export interface NodeTypeOption {
  type: WorkflowNode["type"];
  icon: typeof Bot;
  title: string;
  description: string;
  make: () => WorkflowNode;
}

export const NODE_TYPES: NodeTypeOption[] = [
  {
    type: "agent",
    icon: Bot,
    title: "Agent",
    description: "运行 coding agent 执行 prompt，输出结构化 JSON",
    make: () => ({ id: "", type: "agent", agentId: "", prompt: "" }),
  },
  {
    type: "script",
    icon: Code2,
    title: "Script",
    description: "执行一段确定性 TS 程序（Bun），返回 output",
    make: () => ({ id: "", type: "script", code: "export default async () => ({})" }),
  },
  {
    type: "human",
    icon: UserRound,
    title: "Human",
    description: "暂停并让用户填表确认，答案作为 output",
    make: () => ({ id: "", type: "human", question: "" }),
  },
  {
    type: "end",
    icon: Flag,
    title: "End",
    description: "workflow 出口，携带成功/失败/自定义状态",
    make: () => ({ id: "", type: "end", status: "success" }),
  },
];

export function NodeMenuPopover({
  onPick,
  onClose,
}: {
  onPick: (node: WorkflowNode) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute z-50 w-64 rounded-xl border border-(--hairline) bg-(--panel)/95 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.6)] backdrop-blur">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-widest text-(--mute)">添加下游节点</span>
        <button
          onClick={onClose}
          aria-label="Close node menu"
          className="rounded p-1 text-(--mute) transition-colors hover:bg-(--panel2) hover:text-(--ink)"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {NODE_TYPES.map((opt) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.type}
            onClick={() => {
              onPick(opt.make());
              onClose();
            }}
            className="group flex w-full items-start gap-2.5 rounded-lg p-2  text-left transition-colors hover:bg-(--panel2)"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-(--hairline) bg-(--canvas) text-(--info)">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-(--ink) group-hover:text-(--primary)">
                {opt.title}
              </span>
              <span className="block text-xs text-(--mute)">{opt.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

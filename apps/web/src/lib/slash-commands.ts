import { api } from "@/lib/api";

export interface CommandContext {
  conversationId: string;
  args: string;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  currentRunId: string | null;
  router: { push: (path: string) => void };
  /** Invalidate the GoalStatusBar query after a goal mutation. */
  refreshGoal: () => void;
}

export interface CommandResult {
  handled: true;
  message?: string;
}

export interface SlashCommand {
  command: string;
  description: string;
  argsHint?: string;
  execute: (ctx: CommandContext) => Promise<CommandResult>;
}

export const slashCommands: SlashCommand[] = [
  {
    command: "/clear",
    description: "清空 agent 记忆（保留聊天历史）",
    execute: async (ctx) => {
      await api.clearConversation(ctx.conversationId);
      ctx.toast("记忆已清空", "success");
      return { handled: true };
    },
  },
  {
    command: "/compact",
    description: "总结旧消息，压缩上下文",
    execute: async (ctx) => {
      await api.compactConversation(ctx.conversationId);
      ctx.toast("已压缩", "success");
      return { handled: true };
    },
  },
  {
    command: "/stop",
    description: "停止运行中的 agent",
    execute: async (ctx) => {
      if (!ctx.currentRunId) {
        ctx.toast("当前没有运行中的 agent", "error");
        return { handled: true };
      }
      await api.cancelAgentRun(ctx.currentRunId);
      ctx.toast("已停止", "success");
      return { handled: true };
    },
  },
  {
    command: "/title",
    description: "设置会话标题",
    argsHint: "<标题>",
    execute: async (ctx) => {
      const title = ctx.args.trim();
      if (!title) {
        ctx.toast("用法：/title <标题>", "error");
        return { handled: true };
      }
      await api.updateConversation(ctx.conversationId, { title });
      ctx.toast(`标题已设置：${title}`, "success");
      return { handled: true };
    },
  },
  {
    command: "/export",
    description: "导出会话为 Markdown",
    execute: async (ctx) => {
      const md = await api.exportConversation(ctx.conversationId);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ctx.conversationId}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return { handled: true };
    },
  },
  {
    command: "/goal",
    description: "设置 / 查看 / 清除目标条件",
    argsHint: "<条件> | status | clear | pause | resume",
    execute: async (ctx) => {
      const args = ctx.args.trim();

      // /goal (no args) or /goal status -> show status
      if (!args || args === "status") {
        const goal = await api.getGoal(ctx.conversationId);
        if (!goal.condition) {
          ctx.toast("未设置目标", "info");
        } else {
          ctx.toast(
            `目标：${goal.condition}\n轮数：${goal.turns}\n已暂停：${goal.paused ? "是" : "否"}\n最近：${goal.lastReason ?? "-"}`,
            "info",
          );
        }
        return { handled: true };
      }

      // /goal clear|stop|cancel
      if (args === "clear" || args === "stop" || args === "cancel") {
        await api.setGoal(ctx.conversationId, { action: "clear" });
        ctx.refreshGoal();
        ctx.toast("目标已清除", "success");
        return { handled: true };
      }

      // /goal pause
      if (args === "pause") {
        await api.setGoal(ctx.conversationId, { action: "pause" });
        ctx.refreshGoal();
        ctx.toast("目标已暂停", "info");
        return { handled: true };
      }

      // /goal resume
      if (args === "resume") {
        await api.setGoal(ctx.conversationId, { action: "resume" });
        ctx.refreshGoal();
        ctx.toast("目标已恢复", "success");
        return { handled: true };
      }

      // /goal <condition> -> set
      await api.setGoal(ctx.conversationId, { action: "set", condition: args });
      ctx.refreshGoal();
      ctx.toast(`目标已设置：${args}`, "success");
      return { handled: true };
    },
  },
  {
    command: "/help",
    description: "显示可用命令",
    execute: async (ctx) => {
      const lines = slashCommands.map(
        (c) => `  ${c.command} ${c.argsHint ?? ""} - ${c.description}`,
      );
      ctx.toast(lines.join("\n"), "info");
      return { handled: true };
    },
  },
];

export function findCommand(input: string): SlashCommand | undefined {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  return slashCommands.find((c) => c.command === cmd);
}

export function parseArgs(input: string): string {
  const parts = input.trim().split(/\s+/);
  return parts.slice(1).join(" ");
}

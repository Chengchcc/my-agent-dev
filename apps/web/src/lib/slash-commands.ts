import { api } from "@/lib/api";

export interface CommandContext {
  conversationId: string;
  args: string;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  currentRunId: string | null;
  router: { push: (path: string) => void };
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
    description: "Clear agent memory (keep chat history)",
    execute: async (ctx) => {
      await api.clearConversation(ctx.conversationId);
      ctx.toast("Memory cleared", "success");
      return { handled: true };
    },
  },
  {
    command: "/compact",
    description: "Summarize old messages and compress context",
    execute: async (ctx) => {
      await api.compactConversation(ctx.conversationId);
      ctx.toast("Compressed", "success");
      return { handled: true };
    },
  },
  {
    command: "/stop",
    description: "Stop the running agent",
    execute: async (ctx) => {
      if (!ctx.currentRunId) {
        ctx.toast("No agent is currently running", "error");
        return { handled: true };
      }
      await api.cancelAgentRun(ctx.currentRunId);
      ctx.toast("Stopped", "success");
      return { handled: true };
    },
  },
  {
    command: "/title",
    description: "Set conversation title",
    argsHint: "<title>",
    execute: async (ctx) => {
      const title = ctx.args.trim();
      if (!title) {
        ctx.toast("Usage: /title <title>", "error");
        return { handled: true };
      }
      await api.updateConversation(ctx.conversationId, { title });
      ctx.toast(`Title set: ${title}`, "success");
      return { handled: true };
    },
  },
  {
    command: "/export",
    description: "Export conversation as Markdown",
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
    command: "/help",
    description: "Show available commands",
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

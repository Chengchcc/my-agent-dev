import type { SlashCommand } from "@chengchenccc/tui";
import { resolveStandaloneSkillRoots } from "../../cli/initial-input.js";
import { buildSkillIndex } from "../../core/tools/index.js";
import type { CommandDef, TuiSessionContext } from "./tui-commands.js";

export interface SlashSystem {
  commandsWithSkills: CommandDef[];
  slashCommands: SlashCommand[];
  runCommandText: (text: string) => Promise<void>;
}

/** Auto-registered skill commands (pi's /skill:<name> pattern): every
 *  discovered skill becomes a slash command that submits a prompt pointing
 *  the model at the skill. */
export function buildSlashSystem(ctx: TuiSessionContext, commands: CommandDef[]): SlashSystem {
  const skillCommands: ReadonlyArray<{
    name: string;
    description: string;
    argumentHint?: string;
    group: string;
    live?: boolean;
    aliases?: readonly string[];
    run: (args: string) => void;
  }> = buildSkillIndex(resolveStandaloneSkillRoots(ctx.opts.workspaceRoot)).map((sk) => ({
    name: `skill:${sk.name}`,
    description: sk.description || `invoke the ${sk.name} skill`,
    group: "skill",
    run: (args: string) => {
      ctx.pendingPrompt = args
        ? `${args}\n\n(follow the "${sk.name}" skill — skill_load "${sk.name}" first)`
        : `Follow the "${sk.name}" skill (skill_load "${sk.name}" first).`;
    },
  }));
  const commandsWithSkills = [...commands, ...skillCommands];
  ctx.commandsWithSkills = commandsWithSkills;

  // Autocomplete: the editor already triggers on "/" — hand it the table
  // (static commands + auto-registered skill commands).
  const slashCommands: SlashCommand[] = commandsWithSkills.map((c) => {
    const command: SlashCommand = { name: c.name, description: c.description };
    if (c.argumentHint) command.argumentHint = c.argumentHint;
    if (c.name === "model") {
      command.getArgumentCompletions = async (prefix: string) => {
        const models = await ctx.listModels();
        return models.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m }));
      };
    }
    if (c.name === "resume") {
      command.getArgumentCompletions = (prefix: string) =>
        ctx
          .listSessions()
          .filter((s) => s.id.startsWith(prefix))
          .slice(0, 20)
          .map((s) => ({
            value: s.id,
            label: s.id,
            description: s.title ?? (s.preview || undefined),
          }));
    }
    return command;
  });

  /** Slash-command dispatch shared by the idle loop and live submissions
   *  (pi's LiveCommandController: /commands execute even mid-run instead of
   *  being steered into the model as literal text). */
  async function runCommandText(text: string): Promise<void> {
    const space = text.indexOf(" ");
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    const args = space === -1 ? "" : text.slice(space + 1).trim();
    const command =
      commandsWithSkills.find((c) => c.name === name) ??
      commandsWithSkills.find((c) => c.aliases?.includes(name));
    if (!command) {
      ctx.pushStatus(`unknown command /${name} — try /help`);
      return;
    }
    if (ctx.liveRuntime && !command.live) {
      ctx.pushStatus(`/${name} is not available while a run is live`);
      return;
    }
    await command.run(args);
  }

  return { commandsWithSkills, slashCommands, runCommandText };
}

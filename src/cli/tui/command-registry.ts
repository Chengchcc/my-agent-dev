import type { SkillFrontmatter } from '../../skills';
import type { SessionStore } from '../../session/store';
import type { CommandHandlerContext } from './types';

export interface SlashCommand {
  name: string;
  description: string;
  type: 'builtin' | 'skill';
  handler?: (ctx: CommandHandlerContext) => Promise<void>;
}

export interface PromptSubmission {
  text: string;
  requestedSkillName: string | null;
}

const BASE_COMMANDS: Omit<SlashCommand, 'handler'>[] = [
  {
    name: 'clear',
    description: 'Clear the current conversation history',
    type: 'builtin',
  },
  {
    name: 'exit',
    description: 'Exit the TUI session',
    type: 'builtin',
  },
  {
    name: 'quit',
    description: 'Exit the TUI session',
    type: 'builtin',
  },
  {
    name: 'help',
    description: 'List available slash commands',
    type: 'builtin',
  },
];

/** Parsed builtin invocation: command name plus any trailing argument string. */
export interface BuiltinInvocation {
  name: SlashCommand['name'];
  args: string;
}

function normalizeCommandName(name: string): string {
  return name.toLowerCase().trim();
}

function scoreCommandMatch(command: SlashCommand, filter: string): number {
  const name = command.name.toLowerCase();
  if (name.startsWith(filter)) {
    return 0; // prefix match gets highest score (comes first)
  }
  if (name.includes(filter)) {
    return 1; // contains match is next
  }
  return 2; // description contains is lower priority
}

function dedupeCommands(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  return commands.filter(cmd => {
    if (seen.has(cmd.name)) return false;
    seen.add(cmd.name);
    return true;
  });
}

export function toSkillCommand(skill: SkillFrontmatter): SlashCommand {
  return {
    name: skill.name,
    description: skill.description,
    type: 'skill',
  };
}

export function getBuiltinCommands(sessionStore: SessionStore): SlashCommand[] {
  // Lazy import to avoid circular dependencies
  const { getSessionCommands } = require('./commands/session-commands');
  return [...BASE_COMMANDS, ...getSessionCommands(sessionStore)];
}

export async function loadAvailableCommands(
  skillsDirs?: string[],
  sessionStore?: SessionStore
): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = sessionStore ? getBuiltinCommands(sessionStore) : BASE_COMMANDS;
  // TODO: load skills when we implement skill browsing
  return dedupeCommands(commands);
}

export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const normalizedFilter = normalizeCommandName(filter);
  if (!normalizedFilter) return commands;

  return commands
    .filter(command => {
      const name = command.name.toLowerCase();
      const description = command.description.toLowerCase();
      return name.includes(normalizedFilter) || description.includes(normalizedFilter);
    })
    .sort((left, right) => scoreCommandMatch(left, normalizedFilter) - scoreCommandMatch(right, normalizedFilter));
}

export function getSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  // Extract the first token after /
  const match = text.match(/^\/([^\s]+)/);
  if (!match) return null;
  return match[1];
}

export function insertSlashCommand(command: SlashCommand): string {
  return `/${command.name} `;
}

export function getHighlightedCommandName(text: string, commands: SlashCommand[]): string | null {
  const match = text.match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return null;
  const commandToken = match[1];
  if (!commandToken) return null;

  const commandName = normalizeCommandName(commandToken);
  return commands.some(command => command.name.toLowerCase() === commandName) ? commandToken : null;
}

export function buildPromptSubmission(text: string, commands: SlashCommand[]): PromptSubmission {
  // Check if it's a complete slash command invocation
  const slashQuery = getSlashQuery(text.trim());
  if (slashQuery === null) {
    return { text, requestedSkillName: null };
  }

  // Check if it's a skill command
  const matched = commands.find(c => c.name.toLowerCase() === slashQuery.toLowerCase() && c.type === 'skill');
  if (matched) {
    return { text, requestedSkillName: matched.name };
  }

  return { text, requestedSkillName: null };
}

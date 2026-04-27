import type { SkillFrontmatter } from '../../skills';
import type { SessionStore } from '../../session/store';
import type { CommandHandlerContext } from './types';
import { compactCommand } from './commands/compact-command';

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

function normalizeCommandName(name: string): string {
  return name.toLowerCase().trim();
}

function scoreCommandMatch(command: SlashCommand, filter: string): number {
  const name = command.name.toLowerCase();
  if (name.startsWith(filter)) {
    return 0; // prefix match gets highest score (comes first)
  }
  if (isSubsequenceMatch(name, filter)) {
    return 1; // subsequence match (e.g. "cl" matches "clear")
  }
  if (name.includes(filter)) {
    return 2; // contains match is next
  }
  return 3; // description contains is lower priority
}

function isSubsequenceMatch(text: string, filter: string): boolean {
  let ti = 0;
  let fi = 0;
  while (ti < text.length && fi < filter.length) {
    if (text[ti] === filter[fi]) {
      fi++;
    }
    ti++;
  }
  return fi === filter.length;
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
  return [...BASE_COMMANDS, compactCommand, ...getSessionCommands(sessionStore)];
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
  return match[1] ?? null;
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

export function getBestCompletion(query: string, commands: SlashCommand[]): string | null {
  const matches = filterCommands(commands, query);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.name;

  // Find longest common prefix among all match names
  const names = matches.map(c => c.name);
  let prefix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    while (!names[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === '') return null;
    }
  }
  return prefix.length > query.length ? prefix : null;
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

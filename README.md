# my-agent

A TypeScript-based AI agent framework built with Bun, featuring a modular architecture for extending functionality through skills and an interactive terminal UI (TUI) powered by Ink.

## Features

- **Modular Skill System**: Extend functionality by adding skills in the `skills/` directory
- **Interactive Terminal UI**: Built with [Ink](https://github.com/vadimdemedes/ink), React-based terminal UI
- **Slash Command Autocomplete**: Fuzzy filtering and keyboard navigation for commands
- **Input History**: Persistent command history browsing
- **Multiple AI Providers**: Supports Claude and OpenAI out of the box
- **Markdown Rendering**: Syntax-highlighted code blocks in the terminal

## Installation

```bash
# Clone the repository
git clone https://github.com/Chengchcc/my-agent-dev.git
cd my-agent-dev

# Install dependencies with Bun
bun install
```

## Configuration

Copy the `.env.example` to `.env` and add your API key:

```bash
cp .env.example .env
# Edit .env to add ANTHROPIC_API_KEY or OPENAI_API_KEY
```

## Usage

### Run the TUI

```bash
bun run tui
```

Or install globally:

```bash
bun install -g .
my-agent-tui
```

### Build

```bash
bun run tsc
```

## Project Structure

```
my-agent/
├── src/
│   ├── cli/tui/          # Terminal UI implementation
│   │   ├── components/  # React components (InputBox, CommandList, etc.)
│   │   ├── hooks/       # Custom React hooks (use-command-input, use-input-history)
│   │   └── command-registry.ts  # Slash command filtering and matching
│   ├── foundation/
│   │   └── providers/   # AI provider implementations (Claude, OpenAI)
│   ├── skills/          # Skill management system
│   ├── agent.ts         # Core agent functionality
│   ├── context.ts       # Context management
│   └── types.ts         # Type definitions
├── skills/              # Place your skills here (each in own directory)
└── bin/
    └── my-agent-tui     # Entry point
```

## Adding Skills

Skills are loaded from the `skills/` directory. Each skill should be in its own directory with a `SKILL.md` file containing frontmatter:

```markdown
---
name: my-skill
description: Description of what my skill does
---

# Skill content goes here
```

The framework automatically discovers and loads skills at startup.

## Architecture

- **Pure Functional State**: Editor transformations are pure functions for predictability
- **React Hooks**: Custom hooks separate state management from UI rendering
- **TypeScript**: Fully typed codebase
- **Ink TUI**: React components for interactive terminal interface

## Development

- TypeScript: `^6.0.3`
- Bun: Latest version recommended
- React: `^18.3.1`
- Ink: `^5.0.1`

## License

MIT

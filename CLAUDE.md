# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This is a TypeScript-based AI agent framework built with Bun, featuring a modular architecture for extending functionality through skills. The project is actively under development.

## Development Commands

- **Compile TypeScript**: `bun run tsc`
- **TypeScript version**: ^6.0.3

## Architecture

### Core Files

- `/src/index.ts`: Main entry point with public exports
- `/src/agent/`: Agent core functionality (everything for the agentic loop in one place)
  - `Agent.ts`: Agent class with `run()`, `runStream()`, `runAgentLoop()`
  - `loop-types.ts`: AgentEvent, AgentLoopConfig, and other event types
  - `context.ts`: ContextManager + compression strategies
  - `middleware.ts`: `composeMiddlewares` utility
  - `tool-registry.ts`: ToolRegistry - manages tool registration/lookup
  - `sub-agent-tool.ts`: SubAgentTool - delegates subtasks to independent agents
- `/src/providers/`: LLM Provider implementations (flattened from foundation/providers)
  - `claude.ts`: Anthropic Claude provider
  - `openai.ts`: OpenAI provider
- `/src/types.ts`: Global shared type definitions (Message, ToolCall, Provider, Middleware, etc.)
- `/src/skills/`: Skill management and injection system
  - `loader.ts`: SkillLoader class for loading skills from disk with caching
  - `middleware.ts`: SkillMiddleware for auto-injecting skills into system prompt

### Terminal UI (TUI)

- `/src/cli/tui/`: Interactive terminal UI implementation powered by Ink (React)
  - `command-registry.ts`: Slash command types, filtering and matching utilities
  - `components/`: React components
    - `App.tsx`: Main application container
    - `InputBox.tsx`: User input with autocomplete
    - `CommandList.tsx`: Autocomplete dropdown for slash commands
    - `HighlightedInput.tsx`: Input display with cursor position highlighting
    - `ToolCallMessage.tsx`: Displays tool call execution status (running/completed/error)
  - `hooks/`: Custom React hooks
    - `use-agent-loop.tsx`: Agent loop context provider (consumes AgentEvent stream from `runAgentLoop()`)
    - `use-command-input.ts`: Main input hook with autocomplete and history
    - `use-input-editor.ts`: Pure editor state transformation functions
    - `use-input-history.ts`: Persistent input history browsing

## Important Files

- `tsconfig.json`: TypeScript configuration
- `package.json`: Project dependencies
- `CLAUDE.md`: This file - project guidance for Claude Code
- `README.md`: Project documentation
- `skills/`: Directory containing available skills (each in separate folder with SKILL.md)
- `bin/`: Executable scripts
  - `my-agent-tui-dev.ts`: Development entry point for TUI (runs TypeScript directly with bun)
  - `my-agent-tui`: Production entry point (runs compiled JavaScript from dist/)

## Development Commands

- **Compile TypeScript**: `bun run tsc`
- **Run TUI in development**: `bun run tui`
- **TypeScript version**: ^6.0.3

## Getting Started

When adding code to this repository:
1. Understand the project requirements and architecture
2. Update this file with relevant commands and architecture documentation as the project takes shape

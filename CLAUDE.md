# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Current State

This is a TypeScript-based AI agent framework built with Bun, featuring a modular architecture for extending functionality through skills, and an interactive terminal UI (TUI) powered by Ink/React. The project is actively under development with many core features complete.

## Development Commands

- **Compile TypeScript**: `bun run tsc` (alias: `bun run build`)
- **Run TUI in development**: `bun run tui` (alias: `bun run dev`)
- **Run tests**: `bun test`
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
  - `index.ts`: Module exports

### Configuration

- `/src/config/`: Centralized YAML configuration system
  - `types.ts`: TypeScript type definitions for all settings
  - `schema.ts`: Zod validation schema
  - `defaults.ts`: Default configuration values
  - `loader.ts`: Configuration loading, merging, tilde expansion
  - `index.ts`: Exported settings singleton
  - `allowed-roots.ts`: Runtime accessor for allowed root directories (security boundaries)
- `/src/providers/`: LLM Provider implementations
  - `claude.ts`: Anthropic Claude provider
  - `claude-utils.ts`: Claude-specific utility functions
  - `openai.ts`: OpenAI provider
  - `index.ts`: Provider exports
- `/src/skills/`: Skill management and injection system
  - `loader.ts`: SkillLoader class for loading skills from disk with caching
  - `middleware.ts`: SkillMiddleware for auto-injecting skills into system prompt
  - `index.ts`: Module exports
- `/src/types.ts`: Global shared type definitions (Message, ToolCall, Provider, Middleware, etc.)

### Built-in Tools

- `/src/tools/`: Collection of built-in tools available to the agent
  - `ask-user-question.ts`: Ask user multiple-choice questions
  - `ask-user-question-manager.ts`: Manager for active user questions
  - `bash.ts`: Execute bash commands
  - `glob.ts`: File pattern matching
  - `grep.ts`: Content search across files
  - `ls.ts`: List directory contents
  - `memory.ts`: Memory system tool integration
  - `read.ts`: Read files from filesystem
  - `text-editor.ts`: Edit file contents
  - `todo-write.ts`: Task management tool
  - `zod-tool.ts`: Zod schema validation for tools
  - `index.ts`: Tool exports

### Memory System

- `/src/memory/`: Persistent memory system for storing user preferences and project context
  - `store.ts`: File-based storage implementation
  - `extractor.ts`: Extract memory content from conversation
  - `retriever.ts`: Retrieve relevant memories for context injection
  - `middleware.ts`: Memory injection middleware for agent loop
  - `tool.ts`: Memory tool for manual operations
  - `types.ts`: Memory type definitions
  - `index.ts`: Module exports

### Task Management

- `/src/todos/`: Task/todo management system
  - `todo-middleware.ts`: Middleware that tracks tasks and updates
  - `types.ts`: Todo type definitions
  - `index.ts`: Module exports

### Configuration and Utilities

- `/src/session/`: Session management
  - `hook.ts`: Session hook definitions
  - `store.ts`: Session storage
- `/src/utils/`: Utility functions
  - `debug.ts`: Debug logging utilities
  - `is-text-file.ts`: Text file detection

### Terminal UI (TUI)

- `/src/cli/tui/`: Interactive terminal UI implementation powered by Ink (React)
  - `command-registry.ts`: Slash command types, filtering and matching utilities
  - `commands/`: Slash command implementations
    - `session-commands.ts`: Session-related commands (tasks, memory, etc.)
  - `types.ts`: TUI type definitions
  - `components/`: React components
    - `App.tsx`: Main application container
    - `InputBox.tsx`: User input with autocomplete
    - `CommandList.tsx`: Autocomplete dropdown for slash commands
    - `HighlightedInput.tsx`: Input display with cursor position highlighting
    - `ToolCallMessage.tsx`: Displays tool call execution status (running/completed/error)
    - `AskUserQuestionPrompt.tsx`: Modal for asking user questions
    - `BlinkContext.tsx`: Context provider for blinking animations
    - `BlinkingText.tsx`: Blinking text animation component
    - `ChatMessage.tsx`: Render chat messages with markdown support
    - `CodeBlock.tsx`: Syntax-highlighted code blocks
    - `DiffView.tsx`: Display code diffs
    - `Footer.tsx`: Status footer
    - `Header.tsx`: Application header with logo
    - `ReadFileView.tsx`: File content viewing
    - `StreamingIndicator.tsx`: Streaming animation indicator
    - `StreamingMessage.tsx`: Streaming message rendering
    - `TodoPanel.tsx`: Task list panel
    - `utils/`: Utility components and helpers
      - `language-map.ts`: Prism language mapping
      - `tokenize-by-line.ts`: Line-based tokenization
  - `hooks/`: Custom React hooks
    - `use-agent-loop.tsx`: Agent loop context provider (consumes AgentEvent stream)
    - `use-command-input.ts`: Main input hook with autocomplete and history
    - `use-input-editor.ts`: Pure editor state transformation functions
    - `use-input-history.ts`: Persistent input history browsing
    - `agent-ui-reducer.ts`: Reducer for TUI UI state
    - `use-ask-user-question-manager.ts`: Hook for managing active questions
    - `index.ts`: Hook exports
  - `utils/`: TUI utilities
    - `tool-format.ts`: Tool output formatting
  - `index.tsx`: TUI main export

## Important Files

- `tsconfig.json`: TypeScript configuration
- `package.json`: Project dependencies
- `CLAUDE.md`: This file - project guidance for Claude Code
- `README.md`: Project documentation
- `skills/`: Directory containing available skills (each in separate folder with SKILL.md)
- `tests/`: Test suite (unit and integration tests for all modules)
- `bin/`: Executable scripts
  - `my-agent-tui-dev.ts`: Development entry point for TUI (runs TypeScript directly with bun)
  - `my-agent-tui`: Production entry point (runs compiled JavaScript from dist/)

## Getting Started

When adding code to this repository:
1. Understand the project requirements and architecture
2. Update this file with relevant commands and architecture documentation as the project takes shape

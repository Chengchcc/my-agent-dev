# my-agent

A terminal-native AI coding agent built with TypeScript and Bun. It runs in your terminal with a rich Ink/React TUI, or headless for scripting and automation.

![TUI Demo](docs/screenshots/tui-demo.jpg)

---

## What it does

You type instructions. The agent reasons, calls tools (reading files, running commands, searching code, editing text), and responds. It remembers things across sessions, learns domain-specific skills, manages task lists, and delegates complex work to sub-agents — all while keeping the conversation within token limits through automatic context compaction.

## Features

**Agent**
- Full autonomous loop: reasoning → tool calls → more reasoning → response
- Multi-provider support (Claude, OpenAI, and compatible APIs)
- Sub-agent delegation for isolating large, self-contained tasks
- Token budget guard that delegates reads/searches to sub-agents when context is tight

**Context**
- Incremental token counting for O(1) budget checks — no UI freeze on large conversations
- 5-tier context compaction: snip large outputs → LLM summarization → emergency truncation → collapse
- Automatic compression when approaching model limits

**Tools**
- `bash` — shell execution with timeout, output truncation, working-dir restrictions
- `read` / `grep` / `glob` / `ls` — filesystem exploration
- `text_editor` — view, create, string-replace, and write files
- `ask_user_question` — multi-choice prompts to the user
- `memory` — search, add, list, forget, consolidate persistent memories
- `todo_write` — task list with merge semantics

**Memory**
- Three persistent stores: semantic (preferences), episodic (past conversations), project (architecture notes)
- Keyword retrieval + LLM extraction and consolidation
- Automatically extracts key information after conversations

**Skills**
- Teach the agent new workflows with markdown files (`skills/<name>/SKILL.md`)
- Progressive loading — skills are listed for the model, full content loaded on demand
- Auto-injection when user mentions a skill by name

**TUI**
- Streaming text with syntax-highlighted code blocks
- Tool call status cards with expandable output (expand with `Enter`, navigate with arrows)
- `/` slash command autocomplete with fuzzy matching
- Token budget bar in the footer with color-coded pressure levels
- Persistent input history

**Sessions**
- Save, load, list, and delete named conversation sessions
- Auto-save after each agent run

## Quick Start

```bash
# Clone and install
git clone https://github.com/Chengchcc/my-agent-dev.git
cd my-agent-dev
bun install

# Configure your API key
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY or OPENAI_API_KEY

# Launch the terminal UI
bun run tui
```

Or run headless:

```bash
bun run agent "Explain the authentication flow in this codebase"
```

## Configuration

Settings are loaded from three layers (lowest to highest priority):

1. Built-in defaults (`src/config/defaults.ts`)
2. Project config (`./settings.yml`)
3. User config (`~/.my-agent/settings.yml`)
4. Environment variables (`MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEBUG`)

All settings are validated against Zod schemas. See `src/config/types.ts` for the full settings interface.

## Commands (TUI)

| Command | Action |
|---------|--------|
| `/help` | Show available commands |
| `/clear` | Clear the conversation |
| `/compact` | Manually trigger context compaction |
| `/sessions save <name>` | Save current conversation |
| `/sessions load <name>` | Load a saved conversation |
| `/sessions list` | List all saved sessions |
| `/sessions delete <name>` | Delete a saved session |
| `/tasks` | Show the task list |
| `/memory search <query>` | Search persistent memory |
| `/exit` | Quit |

Slash commands support fuzzy autocomplete — type `/` and a few characters to filter.

## Project Structure

```
my-agent/
├── bin/                        # CLI entry points (thin wrappers)
├── src/
│   ├── agent/                  # Agent loop, context, budget guard, sub-agents
│   │   ├── compaction/         # Multi-tier context compression
│   │   └── tool-dispatch/      # Tool execution pipeline + middleware
│   ├── cli/tui/                # Ink/React terminal UI
│   │   ├── components/         # ChatMessage, InputBox, Footer, ToolCallMessage, etc.
│   │   ├── hooks/              # State management, agent loop integration
│   │   └── utils/              # Tool output formatting
│   ├── config/                 # YAML-based configuration + Zod validation
│   ├── memory/                 # Persistent memory (stores, retriever, extractor)
│   ├── providers/              # Claude + OpenAI providers
│   ├── session/                # Conversation session persistence
│   ├── skills/                 # Skill loading + injection middleware
│   ├── todos/                  # Task list middleware + types
│   ├── tools/                  # Built-in tool implementations
│   ├── utils/                  # Debug logging, file detection
│   ├── runtime.ts              # Single assembly point for the full runtime
│   └── types.ts                # Shared type definitions
├── skills/                     # Skill definition files (SKILL.md per skill)
└── tests/                      # Test suite (mirrors src/ structure)
```

## Architecture

For a detailed walkthrough — the agent loop, tool dispatch pipeline, memory system, skills, compaction, TUI state management, and how everything fits together — read the **[Design Document](./DESIGN.md)**.

Key architectural principles:

- **Single assembly**: `createAgentRuntime()` in `src/runtime.ts` is the only wiring point. CLI scripts call it; they never construct core objects directly.
- **Async generator loop**: The agent yields discriminated `AgentEvent` objects. The TUI and headless runner consume the same stream.
- **Onion middleware**: Both agent hooks and tool dispatch use composable middleware layers (like Koa/Express).
- **Immutable context**: `AgentContext` carries read-only snapshots. Side effects go through a typed `ToolSink`.
- **Least-destructive compaction**: Snip large outputs before summarizing, summarize before collapsing. LLM calls are the last resort.
- **TypeScript-first**: Full type coverage, exact optional properties, no `any` without justification.

See **[ARCHITECTURE-CONSTITUTION.md](./ARCHITECTURE-CONSTITUTION.md)** for the binding rules enforced in CI.

## Development

```bash
bun install          # Install dependencies
bun run tui          # Launch TUI in development mode
bun run tsc          # Type-check
bun test             # Run tests
bun run check:all    # Full CI check (tsc + tests + architecture guard)
```

- **Runtime**: Bun (latest recommended)
- **Language**: TypeScript ^6.0.3
- **UI**: React ^18.3.1 + Ink ^5.0.1
- **AI SDKs**: `@anthropic-ai/sdk`, `openai`

## License

MIT

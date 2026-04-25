# Documentation Update Implementation Plan

&gt; **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update CLAUDE.md and README.md to reflect the current codebase state, including newly implemented features and corrected directory structures.

**Architecture:** Two tasks - one for each documentation file. Each file will be updated with accurate architecture descriptions and feature lists.

**Tech Stack:** Markdown

---

### Task 1: Update CLAUDE.md

**Files:**
- Modify: `/root/my-agent/CLAUDE.md`

- [ ] **Step 1: Update Development Commands section**

Add the new headless agent command:
```markdown
- **Run headless agent**: `bun run agent` (alias: `bun run headless`)
```

- [ ] **Step 2: Update Agent Core Files section**

Expand agent directory to include new subdirectories:
```markdown
- `/src/agent/`: Agent core functionality (everything for the agentic loop in one place)
  - `Agent.ts`: Agent class with `run()`, `runStream()`, `runAgentLoop()`
  - `loop-types.ts`: AgentEvent, AgentLoopConfig, and other event types
  - `context.ts`: ContextManager + compression strategies
  - `middleware.ts`: `composeMiddlewares` utility
  - `tool-registry.ts`: ToolRegistry - manages tool registration/lookup
  - `sub-agent-tool.ts`: SubAgentTool - delegates subtasks to independent agents
  - `budget-guard.ts`: Token budget management for conversation control
  - `compaction/`: Advanced context compression system
    - `compaction-manager.ts`: Orchestrates compression strategies
    - `types.ts`: Compaction type definitions
    - `budget.ts`: Token budget tracking
    - `continuation.ts`: Handle partial messages during streaming
    - `reactive-strategy.ts`: Dynamic strategy selection
    - `rehydrator.ts`: Restore compacted context
    - `snip-strategy.ts`: Truncate old messages
    - `summarize-strategy.ts`: Summarize old messages
    - `tiered-compaction.ts`: Multi-tier compression logic
    - `tool-output-strategy.ts`: Compact tool output
    - `tiers/`: Compaction tier implementations
      - `auto-compact.ts`: Automatic compression triggers
      - `collapse.ts`: Collapse sequential messages
      - `reactive.ts`: React to token budget pressure
      - `snip.ts`: Message truncation implementation
  - `tool-dispatch/`: Tool execution middleware pipeline
    - `dispatcher.ts`: Main tool execution dispatcher
    - `types.ts`: Tool dispatch type definitions
    - `middleware.ts`: Tool middleware composition
    - `middlewares/`: Individual middleware implementations
      - `budget-guard.ts`: Check token budget before tool execution
      - `logging.ts`: Tool execution logging
      - `permission.ts`: Tool permission checks
      - `read-cache.ts`: Cache read operations
  - `index.ts`: Module exports
```

- [ ] **Step 3: Add Runtime Module section**

Add after Core Files section:
```markdown
### Runtime Module

- `/src/runtime.ts`: Unified runtime configuration and entry point
  - `RuntimeConfig`: Configuration interface for agent initialization
  - Factory exports: Agent, ToolRegistry, ContextManager, SubAgentTool
  - Middleware exports: Todo, Memory, Skill, Session hooks
  - Tool exports: Bash, TextEditor, AskUserQuestion, Read, Grep, Glob, Ls
  - Provider exports: ClaudeProvider, OpenAIProvider
```

- [ ] **Step 4: Update TUI Commands section**

Add compact command to TUI commands list:
```markdown
- `commands/`: Slash command implementations
  - `session-commands.ts`: Session-related commands (tasks, memory, etc.)
  - `compact-command.ts`: Manual context compression trigger
```

- [ ] **Step 5: Update bin files list**

```markdown
- `bin/`: Executable scripts
  - `my-agent.ts`: Headless CLI entry point (runs agent loop without UI)
  - `my-agent-tui-dev.ts`: Development entry point for TUI (runs TypeScript directly with bun)
  - `my-agent-tui`: Production entry point (runs compiled JavaScript from dist/)
```

- [ ] **Step 6: Commit changes**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with current codebase structure"
```

---

### Task 2: Update README.md

**Files:**
- Modify: `/root/my-agent/README.md`

- [ ] **Step 1: Update Features section**

Replace Features with comprehensive list:
```markdown
## Features

- **Modular Skill System**: Extend functionality by adding skills in the `skills/` directory
- **Interactive Terminal UI**: Built with [Ink](https://github.com/vadimdemedes/ink), React-based terminal UI
- **Headless CLI Mode**: Run the agent without the TUI for scripting/automation
- **Slash Command Autocomplete**: Fuzzy filtering and keyboard navigation for commands (tasks, memory, compact)
- **Input History**: Persistent command history browsing
- **Multiple AI Providers**: Supports Claude and OpenAI out of the box
- **Markdown Rendering**: Syntax-highlighted code blocks in the terminal
- **Automatic Context Compression**: Multi-tiered context management with multiple strategies
  - Token budget-based automatic compression
  - Summarization of old messages
  - Tool output compaction
  - Reactive strategy selection
- **Token Budget Management**: Guardrails to prevent context overflow
- **Tool Execution Middleware**: Permission checking, logging, caching, and budget guards
- **Persistent Memory System**: Store user preferences and project context
- **Task Management System**: Built-in todo tracking via middleware
```

- [ ] **Step 2: Update Usage section**

Add headless CLI usage:
```markdown
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

### Run Headless CLI (Script Mode)

```bash
bun run agent "your prompt here"
```

Or install globally:

```bash
bun install -g .
my-agent "your prompt here"
```

### Build

```bash
bun run tsc
```
```

- [ ] **Step 3: Update Project Structure section**

Replace with accurate directory structure:
```markdown
## Project Structure

```
my-agent/
├── src/
│   ├── agent/                    # Core agent functionality
│   │   ├── compaction/          # Context compression system (multi-tier)
│   │   │   ├── tiers/           # Compaction strategy implementations
│   │   │   └── strategies/      # Individual compression strategies
│   │   ├── tool-dispatch/       # Tool execution middleware pipeline
│   │   │   └── middlewares/     # Budget, permission, logging, cache
│   │   ├── Agent.ts             # Main agent loop implementation
│   │   ├── context.ts           # Context management with compression
│   │   └── sub-agent-tool.ts    # Sub-agent delegation tool
│   ├── cli/tui/                 # Terminal UI implementation (Ink/React)
│   │   ├── components/          # React components (InputBox, CommandList, etc.)
│   │   ├── hooks/               # Custom React hooks (use-command-input, use-agent-loop)
│   │   ├── commands/            # Slash command implementations
│   │   └── command-registry.ts  # Slash command filtering and matching
│   ├── config/                  # YAML-based configuration system
│   ├── memory/                  # Persistent memory system (store, extract, retrieve)
│   ├── providers/               # AI provider implementations (Claude, OpenAI)
│   ├── session/                 # Session management and hooks
│   ├── skills/                  # Skill management system (loader, middleware)
│   ├── todos/                   # Task management system
│   ├── tools/                   # Built-in tools (bash, read, edit, grep, etc.)
│   ├── utils/                   # Utility functions (debug, file detection)
│   ├── runtime.ts               # Unified runtime configuration entry
│   ├── types.ts                 # Global type definitions
│   └── index.ts                 # Public API exports
├── skills/                       # Place your skills here (each in own directory)
├── bin/
│   ├── my-agent.ts              # Headless CLI entry point
│   ├── my-agent-tui-dev.ts      # Development TUI entry
│   └── my-agent-tui             # Production TUI entry
└── tests/                        # Test suite
```
```

- [ ] **Step 4: Update Architecture section**

```markdown
## Architecture

- **Pure Functional State**: Editor transformations are pure functions for predictability
- **React Hooks**: Custom hooks separate state management from UI rendering
- **Middleware Composition**: Agent middleware pipeline for memory, skills, and todos
- **Tool Dispatch Pipeline**: Extensible tool execution with permissions and logging
- **Multi-Tier Compaction**: Progressive context compression based on token budget
- **TypeScript**: Fully typed codebase
- **Ink TUI**: React components for interactive terminal interface
```

- [ ] **Step 5: Commit changes**

```bash
git add README.md
git commit -m "docs: update README.md with current features and structure"
```

---

## Plan Self-Review

**Spec coverage:**
- ✅ All discovered new modules covered (compaction, tool-dispatch, runtime.ts)
- ✅ All new tools and features documented
- ✅ Directory structures updated to match actual codebase
- ✅ Headless CLI documented

**Placeholder scan:**
- ✅ No TBD/TODO placeholders
- ✅ All code sections are complete
- ✅ Exact file paths used throughout

**Type consistency:**
- ✅ Module names match actual directory structure
- ✅ File references are consistent across the plan

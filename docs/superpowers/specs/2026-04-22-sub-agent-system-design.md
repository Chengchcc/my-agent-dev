# Sub Agent System Design Specification

## 1. Overview

**Problem:** Single Agent architecture suffers from:
- Context pollution: all intermediate steps accumulate in the main context
- Token cost grows linearly with task length
- One agent cannot be optimal for all roles (analysis vs coding vs testing)
- Long tasks tend to lose focus and go off track

**Solution:** Sub Agent system implements the **divide and conquer** pattern:
- Main Agent (Orchestrator) breaks large tasks into independent sub-tasks
- Each sub-task runs in an independent Sub Agent with its own isolated context
- Sub Agent does its work, returns a concise summary to Main
- Sub Agent context is discarded after completion
- Main context stays clean and focused on high-level planning and tracking

## 2. Architecture

### 2.1 Core Insight: Sub Agent Is Just A Tool

No changes required to the core Agent `runAgentLoop` method. Sub Agent is implemented as a standard `ToolImplementation` that creates and runs a temporary Agent instance internally. This makes the feature fully additive with zero breaking changes.

```
┌─────────────────────────────────────────────────────────────┐
│                     User                                     │
│                              │                                │
│                              ▼                                │
│  ┌── Main Agent (Orchestrator) ──────────────────────────┐   │
│  │   role: task decomposition, progress tracking          │   │
│  │   context: [plan + summaries of completed subtasks]    │   │
│  │   tools: [..., sub_agent]                                │   │
│  └───────────────────────┬────────────────────────────────┘   │
│                      │                                          │
│              ┌─────────▼─────────┐                             │
│              │  Sub Agent 1       │  Independent context       │
│              │  (e.g., Analyst)   │  50K token limit           │
│              │  15 max turns      │  Returns summary           │
│              └────────────────────┘                             │
│              ┌─────────▼─────────┐                             │
│              │  Sub Agent 2       │  Independent context       │
│              │  (e.g., Coder)     │  50K token limit           │
│              │  15 max turns      │  Returns summary           │
│              └────────────────────┘                             │
│                                                                 │
│  ┌──────── Working Directory (~/.my-agent/sub-agents/) ──────┐  │
│  │  <session-id>/plan.md           ← Main writes              │  │
│  │  <session-id>/progress.json     ← shared progress tracking │  │
│  │  <session-id>/context/          ← shared context docs      │  │
│  │  <session-id>/logs/{agentId}.md ← execution logs           │  │
│  │  (project source files)         ← all agents can read/write│  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 3. Core Types

### 3.1 New Agent Events (loop-types.ts)

Three new event types added to the `AgentEvent` union to support UI display of sub-agent execution:

```typescript
export type AgentEvent =
  // ... existing events ...
  | { type: 'sub_agent_start'; agentId: string; task: string; turnIndex: number }
  | { type: 'sub_agent_event'; agentId: string; event: AgentEvent; turnIndex: number }
  | { type: 'sub_agent_done'; agentId: string; summary: string; totalTurns: number; durationMs: number; turnIndex: number };
```

### 3.2 SubAgentTool Configuration

```typescript
export interface SubAgentToolConfig {
  /**
   * List of tool names allowed for the sub-agent.
   * If not provided, inherits all tools from the main agent except 'sub_agent'.
   */
  allowedTools?: string[];

  /**
   * LLM provider to use for this sub-agent.
   * If not provided, inherits the main agent's provider.
   */
  provider?: Provider;

  /**
   * Maximum number of turns (LLM → tools → LLM) for the sub-agent.
   * Default: 15 (lower than main agent's 25 to keep subtasks focused)
   */
  maxTurns?: number;

  /**
   * Total timeout for sub-agent execution in milliseconds.
   * Default: 5 minutes (lower than main's 10 minutes)
   */
  timeoutMs?: number;

  /**
   * Maximum token limit for sub-agent context.
   * Default: 50,000 tokens (smaller than main to keep context focused)
   */
  tokenLimit?: number;

  /**
   * Custom system prompt template. If provided, this overrides the default.
   * The placeholder `{{task}}` will be replaced with the actual task text.
   */
  systemPromptTemplate?: string;

  /**
   * Callback for sub-agent events - allows bubbling events to the main UI.
   */
  onEvent?: (agentId: string, event: AgentEvent) => void;

  /**
   * Session ID for isolating working directory.
   * If not provided, uses a generated ID from the main session.
   */
  sessionId?: string;
}
```

### 3.3 Tool Definition

The `sub_agent` tool has only one required parameter to keep it simple:

```typescript
{
  name: 'sub_agent',
  description: `Delegate a self-contained subtask to an independent agent with its own isolated context.

USE when:
- The subtask needs to read/process many files but the caller only needs a summary
- The subtask requires different expertise (analysis vs coding vs testing)
- Running the subtask inline would bloat the current context with intermediate outputs
- The subtask can be completed independently without interacting back to the user

DO NOT USE when:
- A single tool call (bash/text_editor) can accomplish the task
- You need to interactively refine the result with the user
- The subtask depends on information only available in the current conversation`,
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'A clear, self-contained task description. Include all necessary context or reference files that the sub-agent should read — it cannot see the current conversation.',
      },
    },
    required: ['task'],
  },
}
```

**Design notes:**
- Only one parameter: intentionally minimal to discourage over-configuration by the LLM
- Clear "DO NOT USE" section prevents misuse
- Emphasizes that sub-agent cannot see the current conversation

## 4. Information Flow

Three communication channels between Main and Sub:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| **Parameter** | Main → Sub | Task description (1 paragraph) |
| **File System** | Bidirectional | Plans, progress, shared context in `~/.my-agent/sub-agents/<session-id>/` |
| **Result** | Sub → Main | Execution summary (1 paragraph) |

### 4.1 Progressive Disclosure

Main does **not** embed all context in the `task` parameter. Instead:
1. Layer 1: `task` parameter points to the plan file: "Implement phase 2 per `~/.my-agent/sub-agents/.../plan.md`"
2. Layer 2: Sub agent reads the plan file itself (no token cost to Main)
3. Layer 3: Sub agent explores source files as needed using its own tools

This keeps Main's token consumption low while giving Sub autonomy to read what it needs.

### 4.2 Working Directory Structure

```
~/.my-agent/sub-agents/
└── <session-id>/
    ├── plan.md              # Overall plan (Main creates, Sub can update)
    ├── progress.json        # Structured progress tracking
    │   {
    │     "tasks": [
    │       { "id": "1", "name": "...", "status": "done", "result": "..." },
    │       ...
    │     ]
    │   }
    ├── context/             # Shared context documents
    │   ├── architecture.md # Architecture analysis from earlier Sub
    │   └── conventions.md  # Coding conventions to follow
    └── logs/
        ├── sub-abc123.md   # Full execution log for each sub-agent run
        └── sub-def456.md
```

The directory and all parents are created automatically on first use.

## 5. Execution Flow

```typescript
SubAgentTool.execute({ task }, { signal, context })
  │
  ├─ 1. Generate unique agentId: "sub-" + 6-char nanoid
  │
  ├─ 2. Ensure working directory exists: ~/.my-agent/sub-agents/<session-id>/logs/
  │
  ├─ 3. Build system prompt for sub-agent:
  │     "You are an independent sub-agent executing a focused task.
  │      You have full access to tools to accomplish your task.
  │      When you complete the task, provide a clear concise summary
  │      of what you accomplished and the result.
  │      The main agent will use this summary in its own context."
  │
  ├─ 4. Create independent ContextManager:
  │     - tokenLimit: 50K (default configurable)
  │     - starts empty except system prompt + user task
  │
  ├─ 5. Create ToolRegistry:
  │     - If allowedTools provided: only those tools
  │     - Else: copy all tools from main except 'sub_agent' (recursion protection)
  │
  ├─ 6. Create temporary Agent instance with:
  │     - provider: config.provider ?? mainProvider
  │     - loopConfig: maxTurns 15, timeout 5 minutes (defaults configurable)
  │
  ├─ 7. Emit 'sub_agent_start' event to UI (if onEvent configured)
  │
  ├─ 8. Run agentic loop:
  │     for await (event of tempAgent.runAgentLoop(userMessage)) {
  │       if (onEvent) -> onEvent(agentId, event) // bubble to main UI
  │       collect final assistant message
  │     }
  │
  ├─ 9. Write full execution log to ~/.my-agent/sub-agents/<session>/logs/{agentId}.md
  │
  ├─ 10. Emit 'sub_agent_done' event
  │
  └─ 11. Return final assistant message as string result to main
```

## 6. Error Handling & Safety

| Constraint | Value | Reason |
|------------|-------|--------|
| **Recursion depth** | Max 1 layer (Sub cannot call sub_agent) | Prevents infinite recursion |
| **maxTurns** | Default 15 | Keeps subtasks focused, prevents wandering |
| **Timeout** | Default 5 minutes | Single subtask shouldn't take too long |
| **Token limit** | Default 50K | Subtasks don't need huge context windows |
| **Abort propagation** | Main abort → Sub abort | via AbortSignal chain |
| **Error recovery** | Sub failure returns error as result | Main decides to retry/abort/skip |

Error handling strategy: SubAgentTool **never throws** - it catches all errors and returns them as a formatted string result to Main. This allows Main to handle failures gracefully in its own loop.

## 7. Terminal UI Integration

### 7.1 Event Handling (use-agent-loop.tsx)

The main `use-agent-loop` hook handles the three new event types:
- `sub_agent_start`: creates a new sub-agent entry in the UI state
- `sub_agent_event`: routes inner events to the sub-agent's expansion area
- `sub_agent_done`: updates completion status, duration, summary

### 7.2 SubAgentMessage Component

New React component in `src/cli/tui/components/SubAgentMessage.tsx`:

- **Collapsed state** (default): Shows header with:
  - 🤖 agentId
  - Truncated task preview
  - Status indicator (running/done/error)
  - Turn count and duration when done
- **Expanded state**: Shows full timeline of tool calls from the sub-agent execution
- Border styling differentiates sub-agent output from main output

## 8. Implementation Priorities

| Phase | Content | Status |
|-------|---------|--------|
| **P0** | Core SubAgentTool implementation | ✅ Planned |
| **P0** | Recursion protection (filter sub_agent from ToolRegistry) | ✅ Planned |
| **P0** | Abort signal propagation | ✅ Planned |
| **P1** | Add new sub_agent event types to loop-types | ✅ Planned |
| **P1** | Auto-create ~/.my-agent/sub-agents/ working directory | ✅ Planned |
| **P1** | TUI: Update use-agent-loop to handle sub_agent events | ✅ Planned |
| **P1** | TUI: SubAgentMessage collapsible component | ✅ Planned |
| **P2** | Full configuration options (tokenLimit, maxTurns, etc) | ✅ Planned |
| **P2** | Write execution logs to working directory | ✅ Planned |
| **P3** | Parallel execution of multiple sub-agents | Future |
| **P3** | System prompt template library | Future |

## 9. File Change Summary

| File | Change Type | Purpose |
|------|-------------|---------|
| `src/tools/sub-agent-tool.ts` | New | Main SubAgentTool implementation |
| `src/agent/loop-types.ts` | Modify | Add 3 new sub_agent event types to AgentEvent union |
| `src/tools/index.ts` | Modify | Export SubAgentTool |
| `src/cli/tui/hooks/use-agent-loop.tsx` | Modify | Handle sub_agent events in TUI |
| `src/cli/tui/components/SubAgentMessage.tsx` | New | Collapsible display component for sub-agent |
| `src/cli/tui/components/index.ts` | Modify | Export SubAgentMessage |
| `bin/my-agent-tui-dev.ts` | Modify | Register SubAgentTool on startup |

## 10. Open Questions Decided

1. **Working directory location**: `~/.my-agent/sub-agents/` instead of project-local `.agent/` (per user request)
2. **Default token limit**: 50,000 tokens (per user request)
3. **Auto-create directories**: Yes, automatically create all required directories (per user request)
4. **Scope**: Implement through P2 (everything except parallel execution and template library)

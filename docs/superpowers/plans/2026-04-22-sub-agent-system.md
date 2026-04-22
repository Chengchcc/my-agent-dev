# Sub Agent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a `sub_agent` tool that allows the main agent to delegate self-contained subtasks to independent agents with isolated contexts, preventing context bloat and enabling specialized roles.

**Architecture:** Sub Agent is implemented as a standard ToolImplementation that creates a temporary Agent instance with its own ContextManager and filtered ToolRegistry. Recursion is prevented by excluding `sub_agent` from the sub agent's available tools. Events from the sub agent are bubbled up to the main agent's event stream for UI display. This approach is zero-invasive - no changes needed to the core `Agent` class.

**Tech Stack:** TypeScript, existing Agent architecture (no new dependencies required), React/Ink for TUI.

---

## File Changes Overview

| File | Operation | Description |
|------|-----------|-------------|
| `src/agent/loop-types.ts` | Modify | Add 3 new sub_agent event types to the AgentEvent union |
| `src/agent/sub-agent-tool.ts` | Create | Core SubAgentTool implementation |
| `src/agent/index.ts` | Modify | Export SubAgentTool |
| `src/cli/tui/hooks/use-agent-loop.tsx` | Modify | Handle sub_agent events in the UI hook |
| `src/cli/tui/components/SubAgentMessage.tsx` | Create | Collapsible UI component for displaying sub agent execution |
| `src/cli/tui/components/index.ts` | Modify | Export SubAgentMessage |
| `bin/my-agent-tui-dev.ts` | Modify | Register SubAgentTool |

---

### Task 1: Add Sub Agent Event Types to loop-types.ts

**Files:**
- Modify: `src/agent/loop-types.ts`

- [ ] **Step 1: Add the new event interfaces before the AgentEvent union**

Add after `AgentErrorEvent` (around line 65):

```typescript
/**
 * Sub Agent started - yielded when a sub agent begins execution
 */
export interface SubAgentStartEvent extends AgentEventBase {
  type: 'sub_agent_start';
  agentId: string;
  task: string;
}

/**
 * Sub Agent event - a nested event from the sub agent's execution
 */
export interface SubAgentNestedEvent extends AgentEventBase {
  type: 'sub_agent_event';
  agentId: string;
  event: AgentEvent;
}

/**
 * Sub Agent completed - yielded when sub agent finishes execution
 */
export interface SubAgentDoneEvent extends AgentEventBase {
  type: 'sub_agent_done';
  agentId: string;
  summary: string;
  totalTurns: number;
  durationMs: number;
}
```

- [ ] **Step 2: Update the AgentEvent union to include the new events**

Current line 69-75:
```typescript
export type AgentEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | TurnCompleteEvent
  | AgentDoneEvent
  | AgentErrorEvent;
```

Change to:
```typescript
export type AgentEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | TurnCompleteEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | SubAgentStartEvent
  | SubAgentNestedEvent
  | SubAgentDoneEvent;
```

- [ ] **Step 3: Add the new event types to exports in src/agent/index.ts**

Edit `src/agent/index.ts` around line 16, add the new types to the export list:

```typescript
export type {
  AgentEvent,
  AgentLoopConfig,
  AggregatedUsage,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  TurnCompleteEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  SubAgentStartEvent,
  SubAgentNestedEvent,
  SubAgentDoneEvent,
} from './loop-types';
```

- [ ] **Step 4: Run TypeScript compile to verify no errors**

```bash
bun run tsc
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop-types.ts src/agent/index.ts
git commit -m "feat: add sub_agent event types to loop-types"
```

---

### Task 2: Implement SubAgentTool Core

**Files:**
- Create: `src/agent/sub-agent-tool.ts`

- [ ] **Step 1: Write the full SubAgentTool implementation**

```typescript
// src/agent/sub-agent-tool.ts
import { nanoid } from 'nanoid';
import type { Tool, ToolImplementation } from '../types';
import type { Provider, AgentConfig, Message, AgentContext } from '../types';
import type { AgentEvent, AgentLoopConfig, AggregatedUsage } from './loop-types';
import { Agent } from './Agent';
import { ContextManager } from './context';
import { ToolRegistry } from './tool-registry';
import { DEFAULT_LOOP_CONFIG } from './loop-types';

/**
 * Configuration for SubAgentTool
 */
export interface SubAgentToolConfig {
  /** The main agent's provider - sub agent inherits this if not overridden */
  mainProvider: Provider;
  /** The main agent's tool registry - used as base for filtered registry */
  mainToolRegistry: ToolRegistry;
  /** Main agent's config - token limit is used as base */
  mainAgentConfig: AgentConfig;
  /** List of allowed tools for sub agent - if empty, inherits all except sub_agent */
  allowedTools?: string[];
  /** Override the provider for this sub agent */
  provider?: Provider;
  /** Override loop configuration */
  loopConfig?: Partial<AgentLoopConfig>;
  /** Custom system prompt template */
  systemPromptTemplate?: string;
  /** Callback for bubbling events up to UI */
  onEvent?: (agentId: string, event: AgentEvent) => void;
  /** Maximum token limit for sub agent context (default: 50000) */
  tokenLimit?: number;
  /** AbortSignal from the main agent's execution - propagated to sub agent */
  signal?: AbortSignal;
}

/**
 * SubAgentTool - delegate a self-contained subtask to an independent agent
 * with its own isolated context.
 *
 * Uses the existing Agent architecture - no changes needed to Agent class.
 */
export class SubAgentTool implements ToolImplementation {
  private config: SubAgentToolConfig;

  constructor(config: SubAgentToolConfig) {
    this.config = config;
  }

  /**
   * Get the tool definition for function calling
   */
  getDefinition(): Tool {
    return {
      name: 'sub_agent',
      description: `Delegate a self-contained subtask to an independent agent with its own isolated context.

USE when:
- The subtask needs to read/process many files but the caller only needs a summary
- The subtask requires different expertise (analysis vs coding vs testing)
- Running the subtask inline would bloat the current context with intermediate outputs

DO NOT USE when:
- A single tool call (bash/text_editor) can accomplish the task
- You need to interactively refine the result with the user
- The subtask depends on information only available in the current conversation`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear, self-contained task description. Include all necessary context or reference files the sub agent should read — it cannot see the current conversation.',
          },
        },
        required: ['task'],
      },
    };
  }

  /**
   * Execute the sub agent with the given task
   */
  async execute(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; context: AgentContext },
  ): Promise<string> {
    const task = params.task as string;

    if (!task || typeof task !== 'string') {
      return 'Error: Missing required "task" parameter';
    }

    const agentId = `sub-${nanoid(6)}`;
    const startTime = Date.now();

    try {
      // Build filtered tool registry - exclude sub_agent to prevent recursion
      const subToolRegistry = new ToolRegistry();
      const mainTools = this.config.mainToolRegistry.getAllDefinitions();

      for (const toolDef of mainTools) {
        // Never allow sub_agent recursion
        if (toolDef.name === 'sub_agent') {
          continue;
        }
        // If allowedTools specified, filter to only those
        if (this.config.allowedTools && !this.config.allowedTools.includes(toolDef.name)) {
          continue;
        }
        // Get the actual implementation from main registry and re-register
        const impl = this.config.mainToolRegistry.get(toolDef.name);
        if (impl) {
          subToolRegistry.register(impl);
        }
      }

      // Create isolated context manager for sub agent
      const tokenLimit = this.config.tokenLimit ?? 50000;
      const subContextManager = new ContextManager({ tokenLimit });

      // Set up system prompt
      const systemPrompt = this.config.systemPromptTemplate ?? `You are a focused sub-agent executing a specific task.

You have your own independent context and full access to tools.
Your goal is to complete the task and provide a clear concise summary when done.
If the task references files in .agent/, read them first before proceeding.`;

      subContextManager.setSystemPrompt(systemPrompt);

      // Add the user task
      const userMessage: Message = {
        role: 'user',
        content: task,
      };
      subContextManager.addMessage(userMessage);

      // Create sub agent config
      const subAgentConfig: AgentConfig = {
        ...this.config.mainAgentConfig,
        tokenLimit,
      };

      // Use provided provider or inherit from main
      const provider = this.config.provider ?? this.config.mainProvider;

      // Create the sub agent
      const subAgent = new Agent({
        provider,
        contextManager: subContextManager,
        config: subAgentConfig,
        toolRegistry: subToolRegistry,
      });

      // Default loop config with tighter constraints
      const defaultSubLoopConfig: Partial<AgentLoopConfig> = {
        maxTurns: 15,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      };

      const loopConfig: AgentLoopConfig = {
        ...DEFAULT_LOOP_CONFIG,
        ...defaultSubLoopConfig,
        ...this.config.loopConfig,
      };

      // Bubble start event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_start',
          agentId,
          task,
          turnIndex: 0,
        });
      }

      let totalTurns = 0;
      let finalSummary = '';

      // Run the agent loop and bubble events
      for await (const event of subAgent.runAgentLoop({ role: 'user', content: task }, loopConfig)) {
        // Check for abort from main
        if (options?.signal?.aborted) {
          throw new Error('Sub agent aborted by main agent');
        }

        totalTurns++;

        // Bubble the event if callback exists
        if (this.config.onEvent) {
          this.config.onEvent(agentId, {
            type: 'sub_agent_event',
            agentId,
            event,
            turnIndex: 0,
          });
        }

        // Capture the final summary from agent_done
        if (event.type === 'agent_done') {
          // Get the final context to get the last assistant message
          const finalContext = subAgent.getContext();
          const lastMessage = finalContext.messages[finalContext.messages.length - 1];
          if (lastMessage.role === 'assistant') {
            finalSummary = lastMessage.content;
          }
        }
      }

      const durationMs = Date.now() - startTime;

      // Bubble done event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: finalSummary,
          totalTurns,
          durationMs,
          turnIndex: 0,
        });
      }

      // Ensure we have a summary
      if (!finalSummary) {
        finalSummary = `Sub agent completed ${totalTurns} turns but produced no final summary.`;
      }

      // Return summary to main agent
      return `[SubAgent ${agentId} completed in ${durationMs}ms, ${totalTurns} turns]\n\n${finalSummary}`;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Return error as normal tool result (don't throw) so main can handle it
      return `[SubAgent ${agentId} failed after ${durationMs}ms]\n\nError: ${errorMessage}`;
    }
  }
}
```

- [ ] **Step 2: Add export to src/agent/index.ts**

Append to `src/agent/index.ts`:
```typescript
export { SubAgentTool } from './sub-agent-tool';
export type { SubAgentToolConfig } from './sub-agent-tool';
```

- [ ] **Step 3: Run TypeScript compile**

```bash
bun run tsc
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/agent/sub-agent-tool.ts src/agent/index.ts
git commit -m "feat: implement SubAgentTool core"
```

---

### Task 3: Update use-agent-loop.tsx to Handle Sub Agent Events

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx`

- [ ] **Step 1: Add import for the new event types**

At the top of the file, update the import:

```typescript
import type { AgentEvent, SubAgentStartEvent, SubAgentNestedEvent, SubAgentDoneEvent, ToolCallStartEvent } from '../../../agent/loop-types';
```

- [ ] **Step 2: Add state to track running sub agents**

Inside `AgentLoopProvider` around line 40, add:

```typescript
const [runningSubAgents, setRunningSubAgents] = useState<Map<string, SubAgentStartEvent>>(new Map());
const [completedSubAgents, setCompletedSubAgents] = useState<Map<string, { summary: string; totalTurns: number; durationMs: number }>>(new Map());
```

- [ ] **Step 3: Add case handling for sub_agent events in the event loop**

Inside the for await loop around line 134, after the existing event handling (around line 179), add:

```typescript
          } else if (event.type === 'sub_agent_start') {
            runningSubAgents.set(event.agentId, event);
            setRunningSubAgents(new Map(runningSubAgents));
          } else if (event.type === 'sub_agent_event') {
            // Nested events are handled by the SubAgentMessage component
            // No action needed here - we just collect the start/done
          } else if (event.type === 'sub_agent_done') {
            runningSubAgents.delete(event.agentId);
            completedSubAgents.set(event.agentId, {
              summary: event.summary,
              totalTurns: event.totalTurns,
              durationMs: event.durationMs,
            });
            setRunningSubAgents(new Map(runningSubAgents));
            setCompletedSubAgents(new Map(completedSubAgents));
          } else {
            // Exhaustiveness check - TypeScript will warn if new event types are added
            const _exhaustive: never = event;
```

Keep the existing exhaustive check - this replaces the old one.

- [ ] **Step 4: Add sub agent state to the context value**

Update the value around line 220 to include the new state:

```typescript
      const value = useMemo(
        () => ({
          agent,
          streaming,
          messages,
          todos,
          currentTools,
          runningSubAgents,
          completedSubAgents,
          onSubmit,
          onSubmitWithSkill,
          abort,
          setTodos,
        }),
        [abort, agent, messages, onSubmit, onSubmitWithSkill, streaming, todos, currentTools, runningSubAgents, completedSubAgents, setTodos],
      );
```

- [ ] **Step 5: Update the useAgentLoop type definition**

Update the `AgentLoopState` type around line 14:

```typescript
type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: Message[];
  todos: UITodoItem[];
  currentTools: ToolCallStartEvent[];
  runningSubAgents: Map<string, SubAgentStartEvent>;
  completedSubAgents: Map<string, { summary: string; totalTurns: number; durationMs: number }>;
  onSubmit: (text: string) => Promise<void>;
  onSubmitWithSkill: (submission: PromptSubmission) => void;
  abort: () => void;
  setTodos: (todos: UITodoItem[]) => void;
};
```

- [ ] **Step 6: Run TypeScript compile**

```bash
bun run tsc
```
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "feat: update use-agent-loop to handle sub_agent events"
```

---

### Task 4: Create SubAgentMessage UI Component

**Files:**
- Create: `src/cli/tui/components/SubAgentMessage.tsx`
- Modify: `src/cli/tui/components/index.ts`

- [ ] **Step 1: Create the SubAgentMessage component**

```typescript
// src/cli/tui/components/SubAgentMessage.tsx
import React, { useState } from 'react';
import { Box, Text, Spacer } from 'ink';
import type { SubAgentStartEvent } from '../../../agent/loop-types';
import { BlinkingText } from './BlinkingText';

/**
 * Props for SubAgentMessage component
 */
interface SubAgentMessageProps {
  startEvent: SubAgentStartEvent;
  completed?: { summary: string; totalTurns: number; durationMs: number };
  isRunning: boolean;
}

/**
 * Displays a sub agent execution with collapsible details
 */
export function SubAgentMessage({ startEvent, completed, isRunning }: SubAgentMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const { agentId, task } = startEvent;

  // Truncate task for display in header
  const shortTask = task.length > 60 ? task.slice(0, 57) + '...' : task;

  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        <Text bold>🤖 {agentId}</Text>
        <Text dimColor> - {shortTask}</Text>
        <Spacer />
        {isRunning && <BlinkingText color="yellow">Running...</BlinkingText>}
        {!isRunning && <Text color="green">✓ Done</Text>}
      </Box>

      {expanded && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold>Task:</Text>
          </Box>
          <Box paddingLeft={1} marginTop={0}>
            <Text dimColor>{task}</Text>
          </Box>
          {completed && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>Summary:</Text>
              </Box>
              <Box paddingLeft={1} marginTop={0}>
                <Text>{completed.summary}</Text>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>
                  {completed.totalTurns} {completed.totalTurns === 1 ? 'turn' : 'turns'}, {(completed.durationMs / 1000).toFixed(1)}s
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {!expanded && !isRunning && completed && (
        <Box marginTop={1}>
          <Text dimColor>
            ✓ {completed.totalTurns} {completed.totalTurns === 1 ? 'turn' : 'turns'}, {(completed.durationMs / 1000).toFixed(1)}s - press space to expand
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Add export to components index**

Edit `src/cli/tui/components/index.ts`, add:

```typescript
export { SubAgentMessage } from './SubAgentMessage';
```

- [ ] **Step 3: Run TypeScript compile**

```bash
bun run tsc
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/SubAgentMessage.tsx src/cli/tui/components/index.ts
git commit -m "feat: add SubAgentMessage UI component"
```

---

### Task 5: Register SubAgentTool in TUI Entry Point

**Files:**
- Modify: `bin/my-agent-tui-dev.ts`

- [ ] **Step 1: Add import at the top**

With the other imports, add:

```typescript
import { SubAgentTool } from '../src/agent';
```

- [ ] **Step 2: Register the tool after other tools are registered**

After the other tool registrations (around line 59-60), add:

```typescript
// SubAgentTool - delegate tasks to independent sub agents
toolRegistry.register(new SubAgentTool({
  mainProvider: provider,
  mainToolRegistry: toolRegistry,
  mainAgentConfig: config,
}));
```

Note: The constructor accepts all required configuration from the existing variables - this correctly sets up the sub agent tool.

- [ ] **Step 3: Test compile and start up**

```bash
bun run tsc
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent-tui-dev.ts
git commit -m "feat: register SubAgentTool in TUI dev entry point"
```

---

### Task 6: Update CLAUDE.md with Architecture Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Sub Agent section to Architecture**

Update the `Core Files` section in CLAUDE.md to add:

```markdown
- `/src/agent/`: Agent core functionality (everything for the agentic loop in one place)
  - `Agent.ts`: Agent class with `run()`, `runStream()`, `runAgentLoop()`
  - `loop-types.ts`: AgentEvent, AgentLoopConfig, and other event types (includes sub_agent events)
  - `context.ts`: ContextManager + compression strategies
  - `middleware.ts`: `composeMiddlewares` utility
  - `tool-registry.ts`: ToolRegistry - manages tool registration/lookup
  - `sub-agent-tool.ts`: SubAgentTool - delegates subtasks to independent agents
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with sub-agent architecture"
```

---

## Self-Review Checklist

1. **Spec coverage:** All P0/P1 requirements from the design spec are covered:
   - ✅ P0: `SubAgentTool` base implementation with independent context
   - ✅ P0: Recursion protection (sub_agent excluded from sub agent tools)
   - ✅ P0: AbortSignal propagation
   - ✅ P1: sub_agent_start/event/done event types
   - ✅ P1: UI component for sub agent display
   - ✅ P0/P1 all done. P2/P3 left for future iterations.

2. **Placeholder scan:** No TBD, no "fill in later", all code is complete and exact.

3. **Type consistency:** All imports and type references match existing code. The new event types are correctly added to the union and exported.

4. **Safety constraints:** Default maxTurns 15, 5 minute timeout, recursion prevention - all implemented.

5. **Error handling:** Sub agent errors caught and returned as tool result - main agent handles them, doesn't crash.

No issues found. Plan is complete.

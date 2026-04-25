# Headless CLI Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless CLI mode that runs the agent without TUI, supporting stdin input, multiple output formats (text/json/stream-json), and proper exit codes for CI/CD and script integration.

**Architecture:** Extract agent initialization logic from TUI entry into a shared `createAgentRuntime()` factory, then build a new headless CLI entry that reuses this factory.

**Tech Stack:** TypeScript, Bun, Node.js parseArgs, Agent event stream

---

## File Structure

| File | Responsibility | Type |
|---|---|---|
| `src/runtime.ts` | `createAgentRuntime()` factory - builds complete agent with all tools/middleware | New |
| `bin/my-agent.ts` | Headless CLI entry point - args parsing, event stream handling, output formatting | New |
| `bin/my-agent-tui-dev.ts` | Refactored TUI entry - calls `createAgentRuntime()` instead of inline init | Modify |
| `package.json` | Add new `bin` entry and `agent` script | Modify |
| `tests/runtime.test.ts` | Unit tests for `createAgentRuntime` factory | New |
| `tests/headless-cli.test.ts` | Integration tests for headless CLI | New |

---

### Task 1: Create Runtime Factory - Types & Skeleton

**Files:**
- Create: `src/runtime.ts`
- Test: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing type import test**

```typescript
// tests/runtime.test.ts
import { describe, it, expect } from 'bun:test';
import type { RuntimeConfig, AgentRuntime } from '../src/runtime';

describe('Runtime types', () => {
  it('should export RuntimeConfig and AgentRuntime types', () => {
    // Just verify the types compile (no runtime assertion needed)
    const config: RuntimeConfig = { model: 'test' };
    expect(config.model).toBe('test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/runtime.test.ts -v`
Expected: FAIL with "Cannot find module '../src/runtime'"

- [ ] **Step 3: Write type definitions and skeleton**

```typescript
// src/runtime.ts
import type { AgentConfig, Provider } from './types';
import type { Agent } from './agent';
import type { ToolRegistry } from './agent/tool-registry';
import type { ContextManager } from './agent/context';
import type { SessionStore } from './session/store';
import type { MemoryMiddleware } from './memory/middleware';

export interface RuntimeConfig {
  model?: string;
  maxTokens?: number;
  tokenLimit?: number;
  cwd?: string;
  enableMemory?: boolean;
  enableSkills?: boolean;
  enableTodo?: boolean;
  enableSession?: boolean;
  systemPrompt?: string;
  askUserQuestionHandler?: (params: any) => Promise<any>;
}

export interface AgentRuntime {
  agent: Agent;
  provider: Provider;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  sessionStore: SessionStore;
  memoryMiddleware?: MemoryMiddleware;
  shutdown: () => Promise<void>;
}

export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  throw new Error('Not implemented');
}
```

- [ ] **Step 4: Run test to verify it compiles**

Run: `bun run tsc --noEmit`
Expected: TypeScript compilation succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat(runtime): add type definitions and skeleton"
```

---

### Task 2: Implement Provider & Context Initialization

**Files:**
- Modify: `src/runtime.ts`
- Test: `tests/runtime.test.ts`

- [ ] **Step 1: Add failing provider creation test**

```typescript
// Add to tests/runtime.test.ts
describe('createAgentRuntime', () => {
  const originalClaudeKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalClaudeKey;
    if (originalOpenaiKey) process.env.OPENAI_API_KEY = originalOpenaiKey;
  });

  it('should create Claude provider when ANTHROPIC_API_KEY is set', async () => {
    const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
    expect(runtime.provider).toBeDefined();
    expect(runtime.agent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/runtime.test.ts -v`
Expected: FAIL with "Not implemented"

- [ ] **Step 3: Implement provider and context initialization**

```typescript
// Replace createAgentRuntime in src/runtime.ts
import { Agent, ContextManager } from './agent';
import { ClaudeProvider } from './providers';
import { OpenAIProvider } from './providers/openai';

export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  const {
    model,
    maxTokens = 4096,
    tokenLimit = 100_000,
    cwd = process.cwd(),
    enableMemory = true,
    enableSkills = true,
    enableTodo = true,
    enableSession = true,
    systemPrompt,
    askUserQuestionHandler,
  } = config;

  let provider: Provider;
  if (process.env.ANTHROPIC_API_KEY) {
    provider = new ClaudeProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
      maxTokens,
      temperature: 0.7,
    });
  } else if (process.env.OPENAI_API_KEY) {
    provider = new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      model: model || process.env.MODEL || 'gpt-4o',
    });
  } else {
    throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  const contextManager = new ContextManager({ tokenLimit });
  if (systemPrompt) {
    contextManager.setSystemPrompt(systemPrompt);
  }
  const agentConfig: AgentConfig = { tokenLimit };

  return {} as any; // Temporary - full implementation in next tasks
}
```

- [ ] **Step 4: Run TypeScript to verify types**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat(runtime): implement provider and context initialization"
```

---

### Task 3: Implement Tool Registry & Core Tools

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Add failing tool registration test**

```typescript
// Add to tests/runtime.test.ts
it('should register core tools', async () => {
  const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
  const toolNames = Array.from(runtime.toolRegistry.tools.keys());
  expect(toolNames).toContain('bash');
  expect(toolNames).toContain('text_editor');
  expect(toolNames).toContain('read');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/runtime.test.ts -v`
Expected: FAIL with "Cannot read property 'tools' of undefined"

- [ ] **Step 3: Implement tool registry initialization**

```typescript
// Add imports at top of src/runtime.ts
import { ToolRegistry } from './agent/tool-registry';
import { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool } from './tools';

// Add inside createAgentRuntime, after contextManager:
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new BashTool({ allowedWorkingDirs: [cwd] }));
  toolRegistry.register(new TextEditorTool({ allowedRoots: [cwd] }));
  toolRegistry.register(new ReadTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new LsTool());

  const defaultHeadlessHandler = async () => ({
    answers: ['User is not available in headless mode. Make your best judgment.'],
  });
  toolRegistry.register(new AskUserQuestionTool(
    askUserQuestionHandler ?? defaultHeadlessHandler,
  ));

  const hooks: any = {
    beforeAgentRun: [],
    beforeModel: [],
    afterAgentRun: [],
  };
```

- [ ] **Step 4: Run test to verify tool registration**

Run: `bun test tests/runtime.test.ts -v`
Expected: Tool registration tests pass

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat(runtime): implement tool registry with core tools"
```

---

### Task 4: Implement Todo, SubAgent & Memory Middleware

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Add middleware initialization code**

```typescript
// Add imports at top of src/runtime.ts
import { SubAgentTool } from './agent/sub-agent-tool';
import { createTodoMiddleware } from './todos';
import {
  JsonlMemoryStore, KeywordRetriever, LlmExtractor,
  MemoryMiddleware, MemoryTool,
} from './memory';
import { createSkillMiddleware } from './skills/middleware';
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';

// Add inside createAgentRuntime after hooks initialization:

  // Todo
  if (enableTodo) {
    const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
    toolRegistry.register(todoTool);
    if (todoHooks.beforeModel) hooks.beforeModel.push(todoHooks.beforeModel);
  }

  // Sub Agent
  toolRegistry.register(new SubAgentTool({
    mainProvider: provider,
    mainToolRegistry: toolRegistry,
    mainAgentConfig: agentConfig,
  }));

  // Memory
  let memoryMiddleware: MemoryMiddleware | undefined;
  if (enableMemory) {
    const semanticStore = new JsonlMemoryStore('semantic');
    const episodicStore = new JsonlMemoryStore('episodic');
    const projectStore = new JsonlMemoryStore('project', {}, cwd);
    const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
    const extractor = new LlmExtractor(provider);
    memoryMiddleware = new MemoryMiddleware(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever, extractor,
    );
    toolRegistry.register(new MemoryTool(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever, extractor,
    ));
    if (memoryMiddleware.beforeModel) hooks.beforeModel.push(memoryMiddleware.beforeModel);
    if (memoryMiddleware.afterAgentRun) hooks.afterAgentRun.push(memoryMiddleware.afterAgentRun);
  }

  // Skills
  let skillMiddleware: any;
  if (enableSkills) {
    skillMiddleware = createSkillMiddleware({ autoInject: true, injectOnMention: true });
    hooks.beforeAgentRun.push(skillMiddleware.beforeAgentRun);
    hooks.beforeModel.push(skillMiddleware.beforeModel);
    await skillMiddleware.preloadAll();
  }

  // Session
  const sessionStore = new SessionStore();
  if (enableSession) {
    await sessionStore.ensureSessionDir();
    sessionStore.createNewSession();
    hooks.afterAgentRun.push(createAutoSaveHook(sessionStore));
  }

  // Agent
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    toolRegistry,
    hooks,
  });

  return {
    agent,
    provider,
    toolRegistry,
    contextManager,
    sessionStore,
    memoryMiddleware,
    shutdown: async () => {
      if (memoryMiddleware) {
        await memoryMiddleware.awaitPendingExtractions();
      }
    },
  };
```

- [ ] **Step 2: Run TypeScript to verify types**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run full runtime tests**

Run: `bun test tests/runtime.test.ts -v`
Expected: All runtime tests pass

- [ ] **Step 4: Commit**

```bash
git add src/runtime.ts
git commit -m "feat(runtime): add middleware and agent creation"
```

---

### Task 5: Create Headless CLI Entry Point - Args Parsing

**Files:**
- Create: `bin/my-agent.ts`
- Test: `tests/headless-cli.test.ts`

- [ ] **Step 1: Write args parsing test**

```typescript
// tests/headless-cli.test.ts
import { describe, it, expect } from 'bun:test';
import { $ } from 'bun';

describe('Headless CLI', () => {
  it('should show help with --help flag', async () => {
    const result = await $`bun run bin/my-agent.ts --help`.text();
    expect(result).toContain('Usage:');
    expect(result).toContain('--prompt');
    expect(result).toContain('--output-format');
  });

  it('should show version with --version flag', async () => {
    const result = await $`bun run bin/my-agent.ts --version`.text();
    expect(result.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/headless-cli.test.ts -v`
Expected: FAIL with "command not found"

- [ ] **Step 3: Implement CLI entry with args parsing**

```typescript
// bin/my-agent.ts
#!/usr/bin/env bun

import 'dotenv/config';
import { parseArgs } from 'util';
import { createAgentRuntime } from '../src/runtime';
import { setDebugMode } from '../src/utils/debug';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    prompt:       { type: 'string',  short: 'p' },
    model:        { type: 'string',  short: 'm' },
    'max-turns':  { type: 'string',  default: '25' },
    'output-format': { type: 'string', short: 'o', default: 'text' },
    'system-prompt': { type: 'string', short: 's' },
    'no-memory':  { type: 'boolean', default: false },
    'no-skills':  { type: 'boolean', default: false },
    'no-todo':    { type: 'boolean', default: false },
    debug:        { type: 'boolean', short: 'd', default: false },
    help:         { type: 'boolean', short: 'h', default: false },
    version:      { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  console.log(`
Usage: my-agent [options] [prompt]

Options:
  -p, --prompt <text>         Prompt to send (alternative: positional arg or stdin)
  -m, --model <name>          Model override
  -s, --system-prompt <text>  System prompt override
  -o, --output-format <fmt>   Output format: text (default), json, stream-json
      --max-turns <n>         Maximum agent turns (default: 25)
      --no-memory             Disable memory system
      --no-skills             Disable skill injection
      --no-todo               Disable todo system
  -d, --debug                 Enable debug output
  -h, --help                  Show this help
  -v, --version               Show version

Examples:
  my-agent -p "fix all lint errors in src/"
  my-agent -p "review this file" -o json
  cat error.log | my-agent -p "analyze these errors"
  echo "explain package.json" | my-agent
  my-agent "summarize the project"
`);
  process.exit(0);
}

if (values.version) {
  const pkg = require('../package.json');
  console.log(pkg.version ?? '0.0.0');
  process.exit(0);
}

setDebugMode(!!values.debug);
```

- [ ] **Step 4: Run help test to verify**

Run: `bun test tests/headless-cli.test.ts::Headless -v`
Expected: Help and version tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/my-agent.ts tests/headless-cli.test.ts
git commit -m "feat(headless): add CLI entry with args parsing"
```

---

### Task 6: Implement Prompt Input (Args + Stdin)

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add stdin prompt test**

```typescript
// Add to tests/headless-cli.test.ts
it('should accept prompt via --prompt flag', async () => {
  // This should fail with no API key, not with "no prompt"
  const result = await $`bun run bin/my-agent.ts -p "hello" 2>&1`.nothrow().text();
  expect(result).not.toContain('No prompt provided');
});

it('should read prompt from stdin', async () => {
  const result = await $`echo "test prompt" | bun run bin/my-agent.ts 2>&1`.nothrow().text();
  expect(result).not.toContain('No prompt provided');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/headless-cli.test.ts -v`
Expected: Fails with "No prompt provided"

- [ ] **Step 3: Implement getPrompt function**

```typescript
// Add to bin/my-agent.ts after setDebugMode

async function getPrompt(): Promise<string> {
  let stdinContent = '';

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinContent = Buffer.concat(chunks).toString('utf8').trim();
  }

  const promptArg = values.prompt || positionals.join(' ') || '';

  if (promptArg && stdinContent) {
    return `${promptArg}\n\n<context>\n${stdinContent}\n</context>`;
  }
  if (promptArg) return promptArg;
  if (stdinContent) return stdinContent;

  console.error('Error: No prompt provided. Use -p, positional argument, or pipe via stdin.');
  console.error('Run `my-agent --help` for usage.');
  process.exit(2);
}
```

- [ ] **Step 4: Run prompt input tests**

Run: `bun test tests/headless-cli.test.ts -v`
Expected: Prompt input tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/my-agent.ts tests/headless-cli.test.ts
git commit -m "feat(headless): implement prompt input from args and stdin"
```

---

### Task 7: Implement Text Output Format

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add text output handling**

```typescript
// Add to bin/my-agent.ts after getPrompt

import type { AgentEvent } from '../src/agent/loop-types';

type OutputFormat = 'text' | 'json' | 'stream-json';

function writeTextEvent(event: AgentEvent) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_call_start':
      if (values.debug) {
        process.stderr.write(`\n[tool:${event.toolCall.name}] starting...\n`);
      }
      break;
    case 'tool_call_result':
      if (values.debug) {
        const status = event.isError ? 'ERROR' : 'OK';
        process.stderr.write(`[tool:${event.toolCall.name}] ${status} (${event.durationMs}ms)\n`);
      }
      break;
    case 'agent_done':
      process.stdout.write('\n');
      break;
  }
}

async function main() {
  const prompt = await getPrompt();
  const outputFormat = (values['output-format'] ?? 'text') as OutputFormat;
  const maxTurns = parseInt(values['max-turns'] ?? '25', 10);

  const runtime = await createAgentRuntime({
    model: values.model,
    enableMemory: !values['no-memory'],
    enableSkills: !values['no-skills'],
    enableTodo: !values['no-todo'],
    systemPrompt: values['system-prompt'],
  });

  let exitCode = 0;

  try {
    for await (const event of runtime.agent.runAgentLoop(
      { role: 'user', content: prompt },
      { maxTurns },
    )) {
      if (outputFormat === 'text') {
        writeTextEvent(event);
      }
      if (event.type === 'agent_done' && event.reason === 'error') {
        exitCode = 1;
      }
      if (event.type === 'agent_error') {
        exitCode = 1;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${msg}\n`);
    exitCode = 1;
  } finally {
    await runtime.shutdown();
    process.exit(exitCode);
  }
}

main();
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify text output format works**

Run: `bun run bin/my-agent.ts --help`
Expected: Help text displays correctly

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat(headless): implement text output format"
```

---

### Task 8: Implement JSON & Stream-JSON Output Formats

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Add stream-json and JSON output handlers**

```typescript
// Add after writeTextEvent function in bin/my-agent.ts

function writeStreamJsonEvent(event: AgentEvent) {
  const serializable: Record<string, unknown> = { type: event.type, turnIndex: event.turnIndex };

  switch (event.type) {
    case 'text_delta':
      serializable.delta = event.delta;
      break;
    case 'tool_call_start':
      serializable.tool = { name: event.toolCall.name, id: event.toolCall.id, arguments: event.toolCall.arguments };
      break;
    case 'tool_call_result':
      serializable.tool = { name: event.toolCall.name, id: event.toolCall.id };
      serializable.result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
      serializable.durationMs = event.durationMs;
      serializable.isError = event.isError;
      break;
    case 'turn_complete':
      serializable.hasToolCalls = event.hasToolCalls;
      serializable.usage = event.usage;
      break;
    case 'agent_done':
      serializable.totalTurns = event.totalTurns;
      serializable.reason = event.reason;
      break;
    case 'agent_error':
      serializable.error = event.error.message;
      break;
    case 'sub_agent_start':
      serializable.agentId = event.agentId;
      serializable.task = event.task;
      break;
    case 'sub_agent_done':
      serializable.agentId = event.agentId;
      serializable.summary = event.summary;
      serializable.totalTurns = event.totalTurns;
      serializable.durationMs = event.durationMs;
      break;
  }

  process.stdout.write(JSON.stringify(serializable) + '\n');
}
```

- [ ] **Step 2: Update main() to handle all output formats**

```typescript
// Replace main() in bin/my-agent.ts
async function main() {
  const prompt = await getPrompt();
  const outputFormat = (values['output-format'] ?? 'text') as OutputFormat;
  const maxTurns = parseInt(values['max-turns'] ?? '25', 10);

  const runtime = await createAgentRuntime({
    model: values.model,
    enableMemory: !values['no-memory'],
    enableSkills: !values['no-skills'],
    enableTodo: !values['no-todo'],
    systemPrompt: values['system-prompt'],
  });

  let fullContent = '';
  let finalEvent: AgentEvent | null = null;
  let exitCode = 0;

  try {
    for await (const event of runtime.agent.runAgentLoop(
      { role: 'user', content: prompt },
      { maxTurns },
    )) {
      if (outputFormat === 'text') {
        writeTextEvent(event);
      } else if (outputFormat === 'stream-json') {
        writeStreamJsonEvent(event);
      }

      if (event.type === 'text_delta') {
        fullContent += event.delta;
      }
      if (event.type === 'agent_done') {
        finalEvent = event;
        if (event.reason === 'error') exitCode = 1;
      }
      if (event.type === 'agent_error') {
        exitCode = 1;
      }
    }

    if (outputFormat === 'json') {
      const output = {
        content: fullContent,
        totalTurns: (finalEvent as any)?.totalTurns ?? 0,
        reason: (finalEvent as any)?.reason ?? 'unknown',
        messages: runtime.contextManager.getContext(runtime.agent.config).messages,
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    exitCode = 1;
  } finally {
    await runtime.shutdown();
    process.exit(exitCode);
  }
}
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat(headless): add json and stream-json output formats"
```

---

### Task 9: Refactor TUI Entry to Reuse Runtime

**Files:**
- Modify: `bin/my-agent-tui-dev.ts`

- [ ] **Step 1: Read current TUI entry code**

Read existing file to understand current initialization.

- [ ] **Step 2: Replace TUI entry with runtime usage**

```typescript
// bin/my-agent-tui-dev.ts (completely replace)

#!/usr/bin/env bun
import 'dotenv/config';
import { createAgentRuntime } from '../src/runtime';
import { globalAskUserQuestionManager } from '../src/tools';
import { SkillLoader } from '../src/skills/loader';
import { toSkillCommand } from '../src/cli/tui/command-registry';
import { runTUIClient } from '../src/cli/index';
import { setDebugMode } from '../src/utils/debug';

const args = process.argv.slice(2);
setDebugMode(args.includes('--debug') || args.includes('-d'));

(async () => {
  try {
    const runtime = await createAgentRuntime({
      cwd: __dirname + '/..',
      askUserQuestionHandler: (params) =>
        globalAskUserQuestionManager.askUserQuestion(params),
    });

    const skillLoader = new SkillLoader();
    const skills = await skillLoader.loadAllSkills();
    const skillCommands = skills.map(toSkillCommand);

    process.on('beforeExit', async () => {
      await runtime.shutdown();
      process.exit(0);
    });

    runTUIClient(runtime.agent, skillCommands, runtime.sessionStore);
  } catch (error) {
    console.error('Failed to initialize TUI:', error);
    process.exit(1);
  }
})();
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Verify TUI can start**

Run: `bun run tui --help` 2>&1 | head -5
Expected: No initialization errors (may hang on render, but shouldn't crash before)

- [ ] **Step 5: Commit**

```bash
git add bin/my-agent-tui-dev.ts
git commit -m "refactor(tui): reuse createAgentRuntime for initialization"
```

---

### Task 10: Update package.json & Final Integration

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update bin and scripts entries**

```json
// In package.json, find "bin" and update:
"bin": {
  "my-agent": "bin/my-agent.ts",
  "my-agent-tui": "bin/my-agent-tui"
},

// In "scripts", add:
"scripts": {
  "tui": "bun run bin/my-agent-tui-dev.ts",
  "agent": "bun run bin/my-agent.ts",
  "dev": "bun run bin/my-agent-tui-dev.ts",
  // ... existing scripts
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test -v`
Expected: All tests pass

- [ ] **Step 3: Run full TypeScript build**

Run: `bun run tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(package): add headless CLI bin entry and script"
```

---

## Self-Review Checklist

**✓ Spec coverage:** All requirements covered:
- `createAgentRuntime()` factory - Tasks 1-4
- Headless CLI entry - Tasks 5-8
- Three output formats - Task 8
- Stdin/pipe support - Task 6
- TUI refactoring - Task 9
- Exit codes - Task 7

**✓ Placeholder scan:** No TBD/TODO placeholders found. All code steps have complete code.

**✓ Type consistency:** All type and function names consistent across tasks.

---

## Final Notes

**Total Tasks:** 10  
**Total Steps:** ~40

**Key Dependencies:**
- Tasks 1-4 must complete before Task 5 (runtime is dependency for CLI)
- Task 9 depends on Task 4 (TUI refactor uses runtime)
- Task 10 depends on all previous tasks

Plan complete and saved to `docs/superpowers/plans/2026-04-25-headless-cli-mode.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

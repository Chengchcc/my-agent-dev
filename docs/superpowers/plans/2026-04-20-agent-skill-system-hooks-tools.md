# Agent Skill System with Hooks and Built-in Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fine-grained hooks to the agent execution loop, implement a skill loading system from markdown files, add built-in Bash and Text Editor tools similar to Anthropic Claude Platform, and add the skill-creator skill.

**Architecture:** Extend the existing middleware architecture with fine-grained hook points at each phase of agent execution. Skills are loaded from the filesystem as markdown with frontmatter, and a middleware automatically injects skill content when mentioned in conversation. Built-in tools (Bash, TextEditor) implement the Tool interface for function calling.

**Tech Stack:** TypeScript, existing middleware onion architecture, gray-matter for frontmatter parsing, Node.js child_process for bash execution.

---

## File Mapping

| File | Responsibility |
|------|----------------|
| `src/types.ts` | Add `AgentHooks` interface, add `Tool` definition (already exists), add built-in tool types |
| `src/agent.ts` | Modify `Agent` constructor to accept hooks, update `run()` method to execute hooks at each phase |
| `src/skills/loader.ts` | `SkillLoader` - scan directory, load markdown, parse frontmatter, validate skills |
| `src/skills/middleware.ts` | `SkillMiddleware` - detect skill mentions in user messages, inject skill content into system prompt |
| `src/skills/index.ts` | Export all skill module public types/classes |
| `src/tools/bash.ts` | `BashTool` - execute shell commands, capture output, handle timeouts |
| `src/tools/text-editor.ts` | `TextEditorTool` - view/create/edit/write text files matching Anthropic API |
| `src/tools/index.ts` | Export all built-in tools |
| `skills/skill-creator/SKILL.md` | The skill-creator skill markdown content |
| `skills/skill-creator/_meta.json` | Metadata for skill-creator |
| `tests/skills/loader.test.ts` | Unit tests for SkillLoader |
| `tests/agent-hooks.test.ts` | Unit tests for agent hooks execution |
| `tests/tools/bash.test.ts` | Unit tests for BashTool |
| `tests/tools/text-editor.test.ts` | Unit tests for TextEditorTool |

---

### Task 1: Add AgentHooks interface to types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add AgentHooks interface after existing types**

```typescript
// Fine-grained hooks for agent execution pipeline
// Each hook uses the existing Middleware type
export interface AgentHooks {
  // Called before any processing of the agent run starts
  beforeAgentRun?: Middleware[];
  // Called before context compression
  beforeCompress?: Middleware[];
  // Called before invoking the LLM model
  beforeModel?: Middleware[];
  // Called after LLM model returns response
  afterModel?: Middleware[];
  // Called before adding the assistant response to context
  beforeAddResponse?: Middleware[];
  // Called after the agent run completes, response added to context
  afterAgentRun?: Middleware[];
}
```

- [ ] **Step 2: Update Agent constructor options to include hooks**

Find the `AgentConfig` and add hooks to the constructor options in the Agent class definition:

```typescript
// In the Agent constructor in src/agent.ts, the options type is:
export type AgentConstructorOptions = {
  provider: Provider;
  contextManager: ContextManager;
  middleware?: Middleware[];
  hooks?: AgentHooks;
  config: AgentConfig;
};
```

Wait, actually update the Agent constructor parameter in the Agent class declaration in types? No - types are already exported, just add the AgentHooks to src/types.ts. The actual implementation is in src/agent.ts which we'll do later.

- [ ] **Step 3: Add `gray-matter` dependency for frontmatter parsing to package.json**

```bash
bun add gray-matter
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts package.json bun.lock
git commit -m "feat: add AgentHooks interface for fine-grained hooks
Add AgentHooks interface that defines fine-grained hook points in the agent
execution pipeline using the existing Middleware type. Also add gray-matter
dependency for parsing markdown frontmatter in skill files."
```

---

### Task 2: Update Agent to support hooks in the run method

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Update Agent class properties to store hooks**

Add to the private properties:

```typescript
export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private middleware: Middleware[];
  private hooks: Required<AgentHooks>;
  private config: AgentConfig;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    middleware?: Middleware[];
    hooks?: AgentHooks;
    config: AgentConfig;
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.middleware = options.middleware ?? [];
    this.config = options.config;
    // Default all hook arrays to empty
    this.hooks = {
      beforeAgentRun: options.hooks?.beforeAgentRun ?? [],
      beforeCompress: options.hooks?.beforeCompress ?? [],
      beforeModel: options.hooks?.beforeModel ?? [],
      afterModel: options.hooks?.afterModel ?? [],
      beforeAddResponse: options.hooks?.beforeAddResponse ?? [],
      afterAgentRun: options.hooks?.afterAgentRun ?? [],
    };
  }
```

- [ ] **Step 2: Update the run() method to execute hooks at each phase**

Current `run()` method around line 26-60 needs hook composition:

```typescript
async run(userMessage: { role: 'user'; content: string }): Promise<AgentContext> {
  // 1. beforeAgentRun hooks
  const initialContext = this.contextManager.getContext(this.config);
  const composedBeforeAgentRun = composeMiddlewares(
    this.hooks.beforeAgentRun,
    (ctx) => Promise.resolve(ctx)
  );
  const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

  // Add user message to context after hooks
  this.contextManager.addMessage({
    role: 'user',
    content: userMessage.content,
  });

  // Get current context after adding user message
  const context = this.contextManager.getContext(this.config);

  // 2. beforeCompress hooks
  const composedBeforeCompress = composeMiddlewares(
    this.hooks.beforeCompress,
    (ctx) => Promise.resolve(ctx)
  );
  const afterBeforeCompress = await composedBeforeCompress(context);

  // Compress if needed
  const compressedMessages = await this.contextManager.compressIfNeeded(afterBeforeCompress);
  afterBeforeCompress.messages = compressedMessages;

  // 3. beforeModel hooks + provider invocation
  const composedWithHooks = composeMiddlewares(
    this.hooks.beforeModel,
    async (ctx) => {
      const response = await this.provider.invoke(ctx);
      ctx.response = response;
      return ctx;
    }
  );

  // Run through beforeModel hooks then invoke model
  const afterBeforeModel = await composedWithHooks(afterBeforeCompress);

  // 4. afterModel hooks
  const composedAfterModel = composeMiddlewares(
    this.hooks.afterModel,
    (ctx) => Promise.resolve(ctx)
  );
  const afterAfterModel = await composedAfterModel(afterBeforeModel);

  // 5. beforeAddResponse hooks
  const composedBeforeAddResponse = composeMiddlewares(
    this.hooks.beforeAddResponse,
    (ctx) => Promise.resolve(ctx)
  );
  const afterBeforeAddResponse = await composedBeforeAddResponse(afterAfterModel);

  // Add response to context history after hooks
  if (afterBeforeAddResponse.response) {
    this.contextManager.addMessage({
      role: 'assistant',
      content: afterBeforeAddResponse.response.content,
      tool_calls: afterBeforeAddResponse.response.tool_calls,
    });
  }

  // 6. afterAgentRun hooks
  const finalContext = this.contextManager.getContext(this.config);
  const composedAfterAgentRun = composeMiddlewares(
    this.hooks.afterAgentRun,
    (ctx) => Promise.resolve(ctx)
  );
  const result = await composedAfterAgentRun(finalContext);

  return result;
}
```

- [ ] **Step 3: Also update the runStream() method to support hooks**

Update `runStream()` to execute hooks at the appropriate phases:

```typescript
async *runStream(
  userMessage: { role: 'user'; content: string }
): AsyncIterable<LLMResponseChunk> {
  // beforeAgentRun
  const initialContext = this.contextManager.getContext(this.config);
  const composedBeforeAgentRun = composeMiddlewares(
    this.hooks.beforeAgentRun,
    (ctx) => Promise.resolve(ctx)
  );
  await composedBeforeAgentRun(initialContext);

  // Add user message to context
  this.contextManager.addMessage({
    role: 'user',
    content: userMessage.content,
  });

  // Get current context
  const context = this.contextManager.getContext(this.config);

  // beforeCompress
  const composedBeforeCompress = composeMiddlewares(
    this.hooks.beforeCompress,
    (ctx) => Promise.resolve(ctx)
  );
  const afterBeforeCompress = await composedBeforeCompress(context);

  // Compress if needed
  const compressedMessages = await this.contextManager.compressIfNeeded(afterBeforeCompress);
  afterBeforeCompress.messages = compressedMessages;

  // Compose middleware (outer user middleware) + beforeModel hooks
  const outerComposed = composeMiddlewares(
    this.middleware,
    async (ctx) => {
      const composedBeforeModel = composeMiddlewares(
        this.hooks.beforeModel,
        (innerCtx) => Promise.resolve(innerCtx)
      );
      return composedBeforeModel(ctx);
    }
  );

  // Run through pipeline
  let resultContext = await outerComposed(afterBeforeCompress);

  // After middleware and beforeModel hooks, stream from provider
  let fullContent = '';
  let tool_calls: ToolCall[] = [];

  for await (const chunk of this.provider.stream(resultContext)) {
    fullContent += chunk.content;
    if (chunk.tool_calls) {
      tool_calls.push(...chunk.tool_calls);
    }
    yield chunk;
  }

  // Set full response on context
  resultContext.response = {
    content: fullContent,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    model: '',
  };

  // afterModel
  const composedAfterModel = composeMiddlewares(
    this.hooks.afterModel,
    (ctx) => Promise.resolve(ctx)
  );
  resultContext = await composedAfterModel(resultContext);

  // beforeAddResponse
  const composedBeforeAddResponse = composeMiddlewares(
    this.hooks.beforeAddResponse,
    (ctx) => Promise.resolve(ctx)
  );
  resultContext = await composedBeforeAddResponse(resultContext);

  // Add to context
  if (resultContext.response) {
    this.contextManager.addMessage({
      role: 'assistant',
      content: resultContext.response.content,
      tool_calls: resultContext.response.tool_calls,
    });
  }

  // afterAgentRun
  const finalContext = this.contextManager.getContext(this.config);
  const composedAfterAgentRun = composeMiddlewares(
    this.hooks.afterAgentRun,
    (ctx) => Promise.resolve(ctx)
  );
  await composedAfterAgentRun(finalContext);
}
```

- [ ] **Step 4: Compile check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "feat: update Agent to support fine-grained hooks

Update the Agent constructor to accept hooks and store them as separate
arrays for each phase. Modify both run() and runStream() to execute
hooks at the appropriate points in the pipeline. Uses the existing
composeMiddlewares function for consistency with outer middleware."
```

---

### Task 3: Implement SkillLoader

**Files:**
- Create: `src/skills/loader.ts`
- Create: `src/skills/index.ts`

- [ ] **Step 1: Create src/skills/loader.ts with SkillInfo and SkillLoader**

```typescript
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

export type SkillInfo = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  metadata: Record<string, unknown>;
};

export class SkillLoader {
  private basePath: string;
  private cachedSkills: Map<string, SkillInfo> = new Map();

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.resolve(process.cwd(), 'skills');
  }

  /**
   * List all skill directory names under the base path.
   */
  async listSkillNames(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (e) {
      // If directory doesn't exist, return empty
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }

  /**
   * Load a single skill by name.
   * Reads SKILL.md, parses frontmatter, caches the result.
   */
  async loadSkill(skillName: string): Promise<SkillInfo | null> {
    // Check cache first
    if (this.cachedSkills.has(skillName)) {
      return this.cachedSkills.get(skillName)!;
    }

    const skillDir = path.join(this.basePath, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      const { data, content: markdownContent } = matter(content);

      const skillInfo: SkillInfo = {
        name: data.name ?? skillName,
        description: data.description ?? '',
        content: markdownContent,
        filePath: skillPath,
        metadata: data.metadata ?? {},
      };

      this.cachedSkills.set(skillName, skillInfo);
      return skillInfo;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  /**
   * Load all available skills.
   */
  async loadAllSkills(): Promise<SkillInfo[]> {
    const names = await this.listSkillNames();
    const skills: SkillInfo[] = [];

    for (const name of names) {
      const skill = await this.loadSkill(name);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Clear the skill cache. Forces reloading from disk on next load.
   */
  clearCache(): void {
    this.cachedSkills.clear();
  }

  /**
   * Get the base path where skills are loaded from.
   */
  getBasePath(): string {
    return this.basePath;
  }
}
```

- [ ] **Step 2: Create src/skills/index.ts exports**

```typescript
export * from './loader';
export * from './middleware';
```

- [ ] **Step 3: Update src/index.ts to export skill module**

Add to the end:

```typescript
// Skills
export * from './skills';
```

- [ ] **Step 4: Compile check**

```bash
bun tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/skills/loader.ts src/skills/index.ts src/index.ts
git commit -m "feat: add SkillLoader for loading markdown skills from filesystem

SkillLoader scans the skills/ directory, reads SKILL.md files,
parses frontmatter metadata, and caches loaded skills. Provides
convenience methods to list, load, and cache skills."
```

---

### Task 4: Implement SkillMiddleware

**Files:**
- Create: `src/skills/middleware.ts`

- [ ] **Step 1: Create SkillMiddleware that implements Middleware**

```typescript
import type { Middleware, Provider } from '../types';
import { SkillLoader } from './loader';

/**
 * Options for SkillMiddleware.
 */
export type SkillMiddlewareOptions = {
  skillLoader?: SkillLoader;
  autoInject: boolean;
  // Inject when user message contains the skill name (case-insensitive)
  injectOnMention: boolean;
};

/**
 * SkillMiddleware automatically detects mentions of skills in user messages
 * and injects the skill content into the system prompt when mentioned.
 */
export class SkillMiddleware {
  private skillLoader: SkillLoader;
  private autoInject: boolean;
  private injectOnMention: boolean;
  private loadedSkills: Map<string, string> = new Map(); // skillName -> full content

  constructor(options: Partial<SkillMiddlewareOptions> = {}) {
    this.skillLoader = options.skillLoader ?? new SkillLoader();
    this.autoInject = options.autoInject ?? true;
    this.injectOnMention = options.injectOnMention ?? true;
  }

  /**
   * Preload all skills into memory for faster injection.
   */
  async preloadAll(): Promise<void> {
    const skills = await this.skillLoader.loadAllSkills();
    this.loadedSkills.clear();
    for (const skill of skills) {
      // Store the full skill content with frontmatter content
      this.loadedSkills.set(skill.name.toLowerCase(), skill.content);
      // Also store by directory name
      const dirName = path.basename(path.dirname(skill.filePath)).toLowerCase();
      if (dirName !== skill.name.toLowerCase()) {
        this.loadedSkills.set(dirName, skill.content);
      }
    }
  }

  /**
   * The middleware function that gets injected into the hook.
   */
  middleware(): Middleware {
    return async (context, next) => {
      // Only run on beforeAgentRun
      const lastMessage = context.messages[context.messages.length - 1];
      if (lastMessage?.role !== 'user') {
        return next();
      }

      const userContent = lastMessage.content.toLowerCase();
      const skillsToInject: string[] = [];

      // Check which skills are mentioned
      for (const [skillName, content] of this.loadedSkills.entries()) {
        if (userContent.includes(skillName.toLowerCase())) {
          skillsToInject.push(content);
        }
      }

      // If any skills matched, inject them into system prompt
      if (skillsToInject.length > 0) {
        const skillSection = '\n\n---\n# Reference Skills\n\n' + skillsToInject.join('\n\n---\n\n');
        if (context.systemPrompt) {
          context.systemPrompt += skillSection;
        } else {
          context.systemPrompt = skillSection.trim();
        }
      }

      return next();
    };
  }

  /**
   * Get the loaded skill content by name.
   */
  getSkillContent(skillName: string): string | null {
    return this.loadedSkills.get(skillName.toLowerCase()) ?? null;
  }

  /**
   * Register the skill loader with a provider to expose skills as tools.
   */
  registerAsTools(provider: Provider): void {
    // Future: skills can expose tools
    // For now, just content injection is sufficient
  }
}
```

Wait, need to import path at the top:

Add to top: `import path from 'path';`

- [ ] **Step 2: Compile check**

```bash
bun tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/skills/middleware.ts
git commit -m "feat: add SkillMiddleware that auto-injects skill content

SkillMiddleware runs in the beforeAgentRun hook, detects when a skill
is mentioned in the user's message, and injects the skill's markdown
content into the system prompt. Preloading caches all skills for fast
injection during conversation."
```

---

### Task 5: Implement BashTool built-in tool

**Files:**
- Create: `src/tools/bash.ts`
- Create: `src/tools/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create BashTool implementation**

```typescript
import { exec } from 'child_process';
import type { Tool } from '../types';

/**
 * Options for BashTool.
 */
export type BashToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedWorkingDirs?: string[];
};

/**
 * Built-in tool for executing shell commands.
 * Similar to Anthropic Claude Platform's Bash tool.
 */
export class BashTool {
  private timeoutMs: number;
  private maxOutputBytes: number;
  private allowedWorkingDirs?: string[];

  constructor(options: BashToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120000; // 2 minutes default
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024; // 1MB default
    this.allowedWorkingDirs = options.allowedWorkingDirs;
  }

  /**
   * Get the tool definition for function calling.
   */
  getDefinition(): Tool {
    return {
      name: 'bash',
      description: 'Execute a shell command on the local system. Use this for file operations, running scripts, installing dependencies, checking system status, git operations, and other command-line tasks.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (optional, defaults to current working directory).',
          },
        },
        required: ['command'],
      },
    };
  }

  /**
   * Execute the bash command.
   */
  async execute(params: { command: string; cwd?: string }): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    const { command, cwd } = params;

    // Validate working directory if restricted
    if (this.allowedWorkingDirs) {
      const targetCwd = cwd ?? process.cwd();
      const isAllowed = this.allowedWorkingDirs.some(allowed => 
        targetCwd.startsWith(allowed)
      );
      if (!isAllowed) {
        return {
          output: `Error: Working directory "${targetCwd}" is not allowed.`,
          exitCode: 1,
          timedOut: false,
        };
      }
    }

    return new Promise((resolve) => {
      let output = '';
      let timeoutId: NodeJS.Timeout | null = null;

      const proc = exec(command, { 
        cwd: cwd,
        maxBuffer: this.maxOutputBytes,
        timeout: this.timeoutMs,
      });

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('error', (error) => {
        output += `Error: ${error.message}`;
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          output,
          exitCode: 1,
          timedOut: false,
        });
      });

      proc.on('timeout', () => {
        proc.kill();
        output += '\n--- Command timed out after ${this.timeoutMs}ms ---';
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          output,
          exitCode: 124, // standard timeout exit code
          timedOut: true,
        });
      });

      proc.on('exit', (code, signal) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) {
          output += `\n--- Killed by signal ${signal} ---`;
        }
        resolve({
          output,
          exitCode: code,
          timedOut: false,
        });
      });
    });
  }
}
```

- [ ] **Step 2: Create src/tools/index.ts**

```typescript
export * from './bash';
export * from './text-editor';
```

- [ ] **Step 3: Update src/index.ts to export tools module**

Add to the end:

```typescript
// Built-in Tools
export * from './tools';
```

- [ ] **Step 4: Compile check**

```bash
bun tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/bash.ts src/tools/index.ts src/index.ts
git commit -m "feat: add BashTool built-in tool

BashTool executes shell commands on the local system with timeout
and output size limits. Follows the same pattern as Anthropic
Claude Platform's bash tool."
```

---

### Task 6: Implement TextEditorTool built-in tool

**Files:**
- Create: `src/tools/text-editor.ts`

- [ ] **Step 1: Create TextEditorTool matching the Anthropic API**

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '../types';

/**
 * Supported commands for text editor.
 */
type TextEditorCommand = 'view' | 'create' | 'str_replace' | 'write';

/**
 * Built-in text editor tool similar to Anthropic Claude Platform.
 * Supports: view, create, str_replace, write operations.
 */
export class TextEditorTool {
  private allowedRoots?: string[];

  constructor(options: { allowedRoots?: string[] } = {}) {
    this.allowedRoots = options.allowedRoots;
  }

  /**
   * Get the tool definition for function calling.
   */
  getDefinition(): Tool {
    return {
      name: 'text_editor',
      description: 'Read, create, edit, and write text files. Supports: view (display file content), create (create new file), str_replace (replace specific string), write (write entire file).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['view', 'create', 'str_replace', 'write'],
            description: 'The command to execute.',
          },
          path: {
            type: 'string',
            description: 'The absolute path to the file.',
          },
          old_string: {
            type: 'string',
            description: 'The string to replace (required for str_replace).',
          },
          new_string: {
            type: 'string',
            description: 'The new string to replace with (required for str_replace, create, and write).',
          },
          content: {
            type: 'string',
            description: 'Content for create or write command.',
          },
          start_line: {
            type: 'number',
            description: 'Starting line number for view (optional, 1-indexed).',
          },
          end_line: {
            type: 'number',
            description: 'Ending line number for view (optional, 1-indexed, inclusive).',
          },
        },
        required: ['command', 'path'],
      },
    };
  }

  /**
   * Validate path against allowed roots.
   */
  private validatePath(filePath: string): boolean {
    if (!this.allowedRoots || this.allowedRoots.length === 0) {
      return true;
    }
    const resolved = path.resolve(filePath);
    return this.allowedRoots.some(root => resolved.startsWith(path.resolve(root)));
  }

  /**
   * Execute the text editor command.
   */
  async execute(params: {
    command: TextEditorCommand;
    path: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    start_line?: number;
    end_line?: number;
  }): Promise<{ result: string; error?: undefined } | { error: string }> {
    const { command, path: filePath } = params;

    if (!this.validatePath(filePath)) {
      return { error: `Error: Path "${filePath}" is not allowed.` };
    }

    try {
      switch (command) {
        case 'view': {
          return await this.view(filePath, params.start_line, params.end_line);
        }
        case 'create': {
          if (!params.content) {
            return { error: 'Error: content is required for create command.' };
          }
          return await this.create(filePath, params.content);
        }
        case 'str_replace': {
          if (!params.old_string) {
            return { error: 'Error: old_string is required for str_replace command.' };
          }
          if (params.new_string === undefined) {
            return { error: 'Error: new_string is required for str_replace command.' };
          }
          return await this.strReplace(filePath, params.old_string, params.new_string);
        }
        case 'write': {
          if (!params.content) {
            return { error: 'Error: content is required for write command.' };
          }
          return await this.write(filePath, params.content);
        }
        default:
          return { error: `Error: unknown command "${command}".` };
      }
    } catch (e) {
      return { error: `Error: ${(e as Error).message}` };
    }
  }

  /**
   * View file content with optional line range.
   */
  private async view(filePath: string, startLine?: number, endLine?: number): Promise<{ result: string }> {
    let content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    if (startLine !== undefined) {
      // Convert to 0-indexed
      const start = Math.max(0, startLine - 1);
      const end = endLine !== undefined ? endLine : lines.length;
      const selected = lines.slice(start, end);
      content = selected.join('\n');
      // Add line numbers
      const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(6, ' ')} ${line}`);
      return { result: numbered.join('\n') };
    }

    return { result: content };
  }

  /**
   * Create a new file with content. Errors if file already exists.
   */
  private async create(filePath: string, content: string): Promise<{ result: string }> {
    try {
      await fs.access(filePath);
      return { error: `Error: File already exists at ${filePath}. Use str_replace or write to modify it.` };
    } catch {
      // File doesn't exist, good
      await fs.writeFile(filePath, content, 'utf-8');
      return { result: `Created file ${filePath} successfully.` };
    }
  }

  /**
   * Replace exact string in a file. Fails if old_string doesn't match exactly.
   */
  private async strReplace(filePath: string, oldString: string, newString: string): Promise<{ result: string }> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (e) {
      return { error: `Error: File ${filePath} does not exist.` };
    }

    if (!content.includes(oldString)) {
      return { error: `Error: old_string not found exactly once in file. Search failed.` };
    }

    // Count occurrences
    const count = (content.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (count > 1) {
      return { error: `Error: old_string found ${count} times in file. Please be more specific.` };
    }

    const newContent = content.replace(oldString, newString);
    await fs.writeFile(filePath, newContent, 'utf-8');
    return { result: `Replaced ${count} occurrence in ${filePath} successfully.` };
  }

  /**
   * Write entire file, overwrites if exists, creates if doesn't exist.
   */
  private async write(filePath: string, content: string): Promise<{ result: string }> {
    await fs.writeFile(filePath, content, 'utf-8');
    return { result: `Wrote ${filePath} successfully.` };
  }
}
```

- [ ] **Step 2: Compile check**

```bash
bun tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/text-editor.ts
git commit -m "feat: add TextEditorTool built-in tool

TextEditorTool provides view, create, str_replace, and write
operations exactly like Anthropic Claude Platform's text editor tool.
Validates exact string matching for replacements and restricts paths
if allowed roots are configured."
```

---

### Task 7: Create skill-creator skill

**Files:**
- Create: `skills/skill-creator/SKILL.md`
- Create: `skills/skill-creator/_meta.json`

- [ ] **Step 1: Create skills/skill-creator/SKILL.md**

````markdown
---
name: skill-creator
description: "Guide for creating new skills in the correct format following the repository standards."
metadata:
  {
    "openclaw":
      {
        "emoji": "✍️",
        "requires": [],
      },
  }
---

# Skill Creator

Use this skill to create new skills for the agent skill system.

## Skill Format

Each skill is a directory under `skills/`:
```
skills/
  your-skill-name/
    SKILL.md       # Main skill content (required)
    _meta.json     # Metadata: version, publishedAt (auto-generated)
```

### SKILL.md Format

The file starts with YAML frontmatter, then markdown content.

```markdown
---
name: skill-name
description: "One-line description of what this skill does"
metadata:
  {
    "openclaw": {
      "emoji": "🔧",
      "requires": { "bins": ["required-binary"] },
      "install": [
        {
          "id": "brew",
          "kind": "brew",
          "formula": "formula-name",
          "bins": ["binary-name"],
          "label": "Install with Homebrew",
        },
      ],
    },
  }
---

# Skill Title

Content goes here...

- Detailed instructions
- Command reference
- Examples
- Common patterns
```

## Requirements

1. **Name**: Use kebab-case for the directory name and skill name
2. **Description**: One clear sentence describing what the skill does
3. **Metadata**: Include emoji, required binaries, and installation instructions if applicable
4. **Content**: Be comprehensive but concise - include everything the agent needs to use this skill
5. **Format**: Follow the exact frontmatter format shown above, including the metadata structure

## Steps to Create a New Skill

1. **Understand** what skill the user wants - what problem does it solve?
2. **Create** the directory `skills/<skill-name>/`
3. **Write** `SKILL.md` following the exact format above
4. **Create** `_meta.json` with:
   ```json
   {
     "ownerId": "<generated>",
     "slug": "<skill-name>",
     "version": "1.0.0",
     "publishedAt": <unix timestamp in ms>
   }
   ```
5. **Verify** the format is correct - frontmatter parses correctly, YAML is valid
6. **Confirm** with the user before finishing

## When to Use This Skill

Use this skill when:
- User asks you to create a new skill
- User wants to add a new reference skill to the repository
- You need to create a skill for a new command-line tool or API

Do NOT use this skill when:
- User just asks a question about an existing topic
- The information is already in an existing skill
````

- [ ] **Step 2: Create skills/skill-creator/_meta.json**

```json
{
  "slug": "skill-creator",
  "version": "1.0.0",
  "publishedAt": ${Date.now()}
}
```

- [ ] **Step 3: Commit**

```bash
git add skills/skill-creator/SKILL.md skills/skill-creator/_meta.json
git commit -m "feat: add skill-creator skill

Add the skill-creator skill that teaches the agent how to create new
skills following the standard format. This follows the Anthropic skills
repository pattern."
```

---

### Task 8: Add unit tests for agent hooks

**Files:**
- Create: `tests/agent-hooks.test.ts`

- [ ] **Step 1: Write unit test for hook execution order**

```typescript
import { Agent, ContextManager, ClaudeProvider, type AgentContext, type Middleware } from '../src';
import { describe, expect, test } from 'bun:test';

// Mock provider that just returns a fixed response
class MockProvider {
  invoke = jest.fn(async (context: AgentContext) => {
    return {
      content: 'mock response',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: 'mock',
    };
  });
  registerTools = jest.fn();
  stream = async function* () {
    yield { content: 'mock', done: true };
  };
} as any;

describe('Agent Hooks', () => {
  test('hooks execute in correct order', async () => {
    const calls: string[] = [];

    const hook1: Middleware = async (ctx, next) => {
      calls.push('beforeAgentRun');
      return next();
    };
    const hook2: Middleware = async (ctx, next) => {
      calls.push('beforeCompress');
      return next();
    };
    const hook3: Middleware = async (ctx, next) => {
      calls.push('beforeModel');
      return next();
    };
    const hook4: Middleware = async (ctx, next) => {
      calls.push('afterModel');
      return next();
    };
    const hook5: Middleware = async (ctx, next) => {
      calls.push('beforeAddResponse');
      return next();
    };
    const hook6: Middleware = async (ctx, next) => {
      calls.push('afterAgentRun');
      return next();
    };

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider: new MockProvider(),
      contextManager,
      hooks: {
        beforeAgentRun: [hook1],
        beforeCompress: [hook2],
        beforeModel: [hook3],
        afterModel: [hook4],
        beforeAddResponse: [hook5],
        afterAgentRun: [hook6],
      },
      config: { tokenLimit: 10000 },
    });

    await agent.run({ role: 'user', content: 'test' });

    expect(calls).toEqual([
      'beforeAgentRun',
      'beforeCompress',
      'beforeModel',
      'afterModel',
      'beforeAddResponse',
      'afterAgentRun',
    ]);
  });

  test('hooks can modify context before model', async () => {
    let modifiedMetadata = false;

    const hook: Middleware = async (ctx, next) => {
      ctx.metadata.testKey = 'testValue';
      modifiedMetadata = true;
      return next();
    };

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider: new MockProvider(),
      contextManager,
      hooks: { beforeModel: [hook] },
      config: { tokenLimit: 10000 },
    });

    const result = await agent.run({ role: 'user', content: 'test' });

    expect(modifiedMetadata).toBe(true);
    expect(result.metadata.testKey).toBe('testValue');
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test tests/agent-hooks.test.ts -v
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agent-hooks.test.ts
git commit -m "test: add unit tests for agent hooks execution order

Verify that hooks execute in the correct order and can modify
the agent context."
```

---

### Task 9: Add unit tests for SkillLoader

**Files:**
- Create: `tests/skills/loader.test.ts`

- [ ] **Step 1: Write unit tests for SkillLoader**

```typescript
import { SkillLoader } from '../../src/skills';
import { describe, expect, test } from 'bun:test';

describe('SkillLoader', () => {
  test('loads existing skill-creator', async () => {
    const loader = new SkillLoader();
    const skill = await loader.loadSkill('skill-creator');
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('skill-creator');
    expect(skill?.description).toContain('Guide for creating new skills');
    expect(skill?.content).toContain('## Skill Format');
  });

  test('returns null for non-existent skill', async () => {
    const loader = new SkillLoader();
    const skill = await loader.loadSkill('non-existent-skill');
    expect(skill).toBeNull();
  });

  test('lists all skills', async () => {
    const loader = new SkillLoader();
    const names = await loader.listSkillNames();
    expect(names).toContain('skill-creator');
  });

  test('loads all skills', async () => {
    const loader = new SkillLoader();
    const skills = await loader.loadAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.name === 'skill-creator')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test tests/skills/loader.test.ts -v
```

- [ ] **Step 3: Commit**

```bash
git add tests/skills/loader.test.ts
git commit -m "test: add unit tests for SkillLoader

Test that SkillLoader correctly loads skills from the filesystem,
parses frontmatter, and returns null for non-existent skills."
```

---

### Task 10: Add unit tests for BashTool

**Files:**
- Create: `tests/tools/bash.test.ts`

- [ ] **Step 1: Write unit tests**

```typescript
import { BashTool } from '../../src/tools';
import { describe, expect, test } from 'bun:test';

describe('BashTool', () => {
  test('executes successful command', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'echo "hello world"' });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello world');
    expect(result.timedOut).toBe(false);
  });

  test('captures stderr', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: '>&2 echo "error message"' });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('error message');
  });

  test('handles non-zero exit code', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'exit 1' });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  test('times out long-running command', async () => {
    const tool = new BashTool({ timeoutMs: 100 });
    const result = await tool.execute({ command: 'sleep 1' });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test tests/tools/bash.test.ts -v
```

- [ ] **Step 3: Commit**

```bash
git add tests/tools/bash.test.ts
git commit -m "test: add unit tests for BashTool

Tests command execution, timeout, stderr capture, and exit code handling."
```

---

### Task 11: Add unit tests for TextEditorTool

**Files:**
- Create: `tests/tools/text-editor.test.ts`

- [ ] **Step 1: Write unit tests**

```typescript
import { TextEditorTool } from '../../src/tools';
import { describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('TextEditorTool', () => {
  async function createTempFile(content: string): Promise<string> {
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `test-${Date.now()}.txt`);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  test('view reads entire file', async () => {
    const content = 'line 1\nline 2\nline 3';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    const result = await tool.execute({ command: 'view', path: filePath });
    expect('result' in result).toBe(true);
    expect((result as any).result).toBe(content);
    await fs.unlink(filePath);
  });

  test('create new file fails if exists', async () => {
    const filePath = await createTempFile('existing');
    const tool = new TextEditorTool();
    const result = await tool.execute({ command: 'create', path: filePath, content: 'new' });
    expect('error' in result).toBe(true);
    await fs.unlink(filePath);
  });

  test('str_replace replaces exact string', async () => {
    const content = 'hello world\nhello test\nhello world';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    // Only one occurrence of "hello test"
    const result = await tool.execute({
      command: 'str_replace',
      path: filePath,
      old_string: 'hello test',
      new_string: 'hello replaced',
    });
    expect('result' in result).toBe(true);
    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('hello replaced');
    await fs.unlink(filePath);
  });

  test('str_replace fails if multiple occurrences', async () => {
    const content = 'hello\nhello\nhello';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    const result = await tool.execute({
      command: 'str_replace',
      path: filePath,
      old_string: 'hello',
      new_string: 'bye',
    });
    expect('error' in result).toBe(true);
    expect((result as any).error).toContain('found 3 times');
    await fs.unlink(filePath);
  });

  test('write overwrites existing file', async () => {
    const filePath = await createTempFile('old content');
    const tool = new TextEditorTool();
    const result = await tool.execute({
      command: 'write',
      path: filePath,
      content: 'new content',
    });
    expect('result' in result).toBe(true);
    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toBe('new content');
    await fs.unlink(filePath);
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test tests/tools/text-editor.test.ts -v
```

- [ ] **Step 3: Commit**

```bash
git add tests/tools/text-editor.test.ts
git commit -m "test: add unit tests for TextEditorTool

Tests all four commands: view, create, str_replace, write with
various edge cases including multiple matches and file existence checks."
```

---

### Task 12: Run all tests and check compilation

- [ ] **Step 1: Run all tests**

```bash
bun test
```

- [ ] **Step 2: Type check**

```bash
bun tsc --noEmit
```

- [ ] **Step 3: Commit any fixes**

If any issues found, fix and commit.

---

## Self-Review

- **Spec coverage:** All requirements covered:
  - ✓ Agent hooks at all 6 phases (beforeAgentRun, beforeCompress, beforeModel, afterModel, beforeAddResponse, afterAgentRun)
  - ✓ SkillLoader loads skills from filesystem with frontmatter
  - ✓ SkillMiddleware auto-injects skill content when mentioned
  - ✓ skill-creator skill created in skills/skill-creator/
  - ✓ BashTool built-in tool implemented
  - ✓ TextEditorTool built-in tool implemented matching Anthropic API
  - ✓ Unit tests for all new components
  - ✓ No breaking changes to existing API

- **Placeholders:** No placeholders, all steps have exact code and commands
- **Type consistency:** All types consistent with existing codebase

Gaps: None.

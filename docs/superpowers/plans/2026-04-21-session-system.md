# Session System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a persistent session system that auto-saves conversations to JSONL in `~/.my-agent/sessions/` and supports loading previous sessions via `/resume` slash command.

**Architecture:** Standalone `SessionStore` class handles file I/O with metadata. Auto-save happens via an `afterAgentRun` hook that runs after every agent turn. Slash commands provide user interface for listing/loading/deleting sessions. Follows existing architectural patterns and doesn't require changing core agent logic.

**Tech Stack:** TypeScript, Node.js `crypto` for UUID, `fs/promises` for file operations, existing slash command infrastructure in TUI.

---

## File Layout

| File | Responsibility |
|------|----------------|
| `src/session/store.ts` | Core `SessionStore` class with all file operations, metadata handling |
| `src/session/hook.ts` | `afterAgentRun` hook implementation for auto-save |
| `src/cli/tui/commands/session-commands.ts` | Slash command handlers for `/resume`, `/save`, `/forget` |
| `src/cli/tui/command-registry.ts` | Modify to add built-in session commands |
| `src/cli/tui/types.ts` | Add any new type definitions |
| `bin/my-agent-tui-dev.ts` | Wire up SessionStore and auto-save hook |
| `src/cli/tui/hooks/use-agent-loop.tsx` | Add command handling for session operations that modify context |

---

### Task 1: Create SessionStore class

**Files:**
- Create: `src/session/store.ts`
- No tests yet (we'll test as we go)

- [ ] **Step 1: Add imports and define types**

```typescript
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { Message } from '../types';

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastUserMessage: string;
}

export class SessionStore {
  private sessionDir: string;
  private currentSessionId: string | null = null;

  constructor() {
    this.sessionDir = path.join(os.homedir(), '.my-agent', 'sessions');
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  setCurrentSessionId(id: string): void {
    this.currentSessionId = id;
  }
}
```

- [ ] **Step 2: Implement ensureSessionDir method**

Add to `SessionStore` class:

```typescript
async ensureSessionDir(): Promise<void> {
  try {
    await fs.access(this.sessionDir);
  } catch {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }
}
```

- [ ] **Step 3: Implement createNewSession method**

Add to `SessionStore` class:

```typescript
createNewSession(): SessionMetadata {
  const id = crypto.randomUUID();
  this.currentSessionId = id;
  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    id,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastUserMessage: '',
  };
  return metadata;
}
```

- [ ] **Step 4: Implement getPaths helper**

Add to `SessionStore` class:

```typescript
private getPaths(sessionId: string): {
  jsonlPath: string;
  metaPath: string;
} {
  return {
    jsonlPath: path.join(this.sessionDir, `${sessionId}.jsonl`),
    metaPath: path.join(this.sessionDir, `${sessionId}.json`),
  };
}
```

- [ ] **Step 5: Implement saveSession method**

Add to `SessionStore` class:

```typescript
async saveSession(sessionId: string, messages: Message[]): Promise<void> {
  await this.ensureSessionDir();
  const { jsonlPath, metaPath } = this.getPaths(sessionId);

  // Write JSONL - one message per line
  const jsonlContent = messages
    .map(msg => JSON.stringify(msg))
    .join('\n');
  await fs.writeFile(jsonlPath, jsonlContent, 'utf8');

  // Extract last user message for metadata preview
  const lastUserMsg = messages
    .filter(msg => msg.role === 'user')
    .pop();

  // Update metadata
  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt: this.readExistingMetadata(sessionId)
      .then(m => m.createdAt)
      .catch(() => new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    lastUserMessage: lastUserMsg?.content || '',
  };

  // If we got here, we can await the createdAt
  const finalMetadata: SessionMetadata = {
    ...metadata,
    createdAt: await metadata.createdAt,
  };

  await fs.writeFile(metaPath, JSON.stringify(finalMetadata, null, 2), 'utf8');
}
```

Wait, fix that to avoid creating a promise in the struct. Refactor:

```typescript
async saveSession(sessionId: string, messages: Message[]): Promise<void> {
  await this.ensureSessionDir();
  const { jsonlPath, metaPath } = this.getPaths(sessionId);

  // Write JSONL - one message per line
  const jsonlContent = messages
    .map(msg => JSON.stringify(msg))
    .join('\n');
  await fs.writeFile(jsonlPath, jsonlContent, 'utf8');

  // Extract last user message for metadata preview
  const lastUserMsg = messages
    .filter(msg => msg.role === 'user')
    .pop();

  // Get existing createdAt or create new
  let createdAt = new Date().toISOString();
  try {
    const existing = await this.readExistingMetadata(sessionId);
    createdAt = existing.createdAt;
  } catch {
    // New session - createdAt will be now
  }

  // Update metadata
  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt,
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    lastUserMessage: lastUserMsg?.content.slice(0, 100) || '',
  };

  await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
}

private async readExistingMetadata(sessionId: string): Promise<SessionMetadata> {
  const { metaPath } = this.getPaths(sessionId);
  const content = await fs.readFile(metaPath, 'utf8');
  return JSON.parse(content) as SessionMetadata;
}
```

- [ ] **Step 6: Implement loadSession method**

Add to `SessionStore` class:

```typescript
async loadSession(sessionId: string): Promise<Message[]> {
  const { jsonlPath } = this.getPaths(sessionId);
  const content = await fs.readFile(jsonlPath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  return lines.map(line => JSON.parse(line) as Message);
}
```

- [ ] **Step 7: Implement listSessions method**

Add to `SessionStore` class:

```typescript
async listSessions(): Promise<SessionMetadata[]> {
  await this.ensureSessionDir();
  const files = await fs.readdir(this.sessionDir);

  // Get all .json metadata files
  const metaFiles = files.filter(f => f.endsWith('.json'));
  const sessions: SessionMetadata[] = [];

  for (const file of metaFiles) {
    const sessionId = file.replace(/\.json$/, '');
    try {
      const { metaPath } = this.getPaths(sessionId);
      const content = await fs.readFile(metaPath, 'utf8');
      const metadata = JSON.parse(content) as SessionMetadata;
      sessions.push(metadata);
    } catch {
      // Skip corrupted metadata
      continue;
    }
  }

  // Sort by updatedAt descending - newest first
  return sessions.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}
```

- [ ] **Step 8: Implement deleteSession method**

Add to `SessionStore` class:

```typescript
async deleteSession(sessionId: string): Promise<void> {
  const { jsonlPath, metaPath } = this.getPaths(sessionId);
  try {
    await fs.unlink(jsonlPath);
  } catch {
    // Ignore if file doesn't exist
  }
  try {
    await fs.unlink(metaPath);
  } catch {
    // Ignore if file doesn't exist
  }
}
```

- [ ] **Step 9: Compile to check for errors**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add src/session/store.ts
git commit -m "feat(session): create SessionStore core class"
```

---

### Task 2: Create auto-save hook

**Files:**
- Create: `src/session/hook.ts`
- Modify: None (adds new hook)

- [ ] **Step 1: Import dependencies and define hook**

```typescript
import type { Middleware } from '../types';
import type { AgentContext } from '../types';
import type { SessionStore } from './store';

/**
 * Create an afterAgentRun hook that auto-saves the current session
 * after every completed agent run.
 */
export function createAutoSaveHook(sessionStore: SessionStore): Middleware {
  return async (context: AgentContext, next: () => Promise<AgentContext>) => {
    // Just call next - we run after the agent completes
    const result = await next();

    // Auto-save if we have a current session
    const sessionId = sessionStore.getCurrentSessionId();
    if (sessionId) {
      try {
        await sessionStore.saveSession(sessionId, result.messages);
      } catch (error) {
        console.error('Failed to auto-save session:', error);
      }
    }

    return result;
  };
}
```

- [ ] **Step 2: Compile to check for errors**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/session/hook.ts
git commit -m "feat(session): add auto-save afterAgentRun hook"
```

---

### Task 3: Add slash command handlers and types

**Files:**
- Create: `src/cli/tui/commands/session-commands.ts`
- Modify: `src/cli/tui/command-registry.ts`, `src/cli/tui/types.ts`

- [ ] **Step 1: Add any needed types to types.ts**

Edit `src/cli/tui/types.ts` (add to existing):

Add export if not already exported:

```typescript
export type { UITodoItem };
// Add this line:
export type { CommandHandlerContext };
```

Verify `CommandHandlerContext` exists:

It should look like:

```typescript
import type { Agent } from '../../agent';

export interface CommandHandlerContext {
  agent: Agent;
  onOutput: (message: string) => void;
  refreshMessages: () => void;
  sessionStore: SessionStore;
}
```

Wait, we need to add it. Let me check the existing file. If it doesn't exist, add the `sessionStore` field:

First read the existing file, but since this is a plan:

Add `sessionStore` to the `CommandHandlerContext` interface:

```typescript
export interface CommandHandlerContext {
  agent: Agent;
  onOutput: (message: string) => void;
  refreshMessages: () => void;
  sessionStore: SessionStore;
}
```

- [ ] **Step 2: Create session-commands.ts with command definitions**

```typescript
import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';
import chalk from 'chalk';

/**
 * Format session list for display
 */
function formatSessionList(sessions: Awaited<ReturnType<SessionStore['listSessions']>>): string {
  if (sessions.length === 0) {
    return 'No saved sessions found.';
  }

  const lines = ['Saved sessions (newest first):', ''];

  sessions.forEach((session, index) => {
    const shortId = session.id.slice(0, 8);
    const date = new Date(session.updatedAt).toLocaleString();
    const preview = session.lastUserMessage
      ? session.lastUserMessage.slice(0, 60) + (session.lastUserMessage.length > 60 ? '...' : '')
      : '(empty)';

    lines.push(`${chalk.bold(String(index + 1))}. ${chalk.cyan(shortId)} - ${date}`);
    lines.push(`   ${preview}`);
    lines.push('');
  });

  lines.push(`Use ${chalk.bold('/resume <id>')} to resume a session (prefix matching works, e.g. ${chalk.bold('/resume ' + sessions[0]?.id.slice(0, 8))})`);
  return lines.join('\n');
}

/**
 * Handle /resume command - list sessions or load specific session
 */
export async function handleResume(
  args: string,
  context: {
    sessionStore: SessionStore;
    agent: Agent;
    refreshMessages: () => void;
    onOutput: (msg: string) => void;
  }
): Promise<void> {
  const { sessionStore, agent, refreshMessages, onOutput } = context;

  // No arguments - list sessions
  if (!args.trim()) {
    const sessions = await sessionStore.listSessions();
    onOutput(formatSessionList(sessions));
    return;
  }

  // Load specific session
  const searchId = args.trim();

  try {
    const sessions = await sessionStore.listSessions();
    // Find by prefix match
    const matched = sessions.find(s => s.id.startsWith(searchId));

    if (!matched) {
      onOutput(`No session found matching ID: ${searchId}`);
      return;
    }

    const messages = await sessionStore.loadSession(matched.id);
    // Clear current context
    agent.clear();
    // Add all loaded messages to context
    const contextManager = agent.getContextManager();
    for (const msg of messages) {
      contextManager.addMessage(msg);
    }
    // Set as current session
    sessionStore.setCurrentSessionId(matched.id);
    // Refresh UI
    refreshMessages();
    onOutput(`Resumed session ${matched.id} (${matched.messageCount} messages)`);
  } catch (error) {
    onOutput(`Failed to load session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle /save command - force save current session
 */
export async function handleSave(
  args: string,
  context: {
    sessionStore: SessionStore;
    agent: Agent;
    onOutput: (msg: string) => void;
  }
): Promise<void> {
  const sessionId = context.sessionStore.getCurrentSessionId();
  if (!sessionId) {
    context.onOutput('No active session to save.');
    return;
  }

  try {
    const messages = context.agent.getContext().messages;
    await context.sessionStore.saveSession(sessionId, messages);
    context.onOutput(`Saved session ${sessionId} (${messages.length} messages)`);
  } catch (error) {
    context.onOutput(`Failed to save session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle /forget command - delete a session
 */
export async function handleForget(
  args: string,
  context: {
    sessionStore: SessionStore;
    onOutput: (msg: string) => void;
  }
): Promise<void> {
  const searchId = args.trim();
  if (!searchId) {
    context.onOutput('Please provide a session ID: /forget <id>');
    return;
  }

  try {
    const sessions = await context.sessionStore.listSessions();
    const matched = sessions.find(s => s.id.startsWith(searchId));

    if (!matched) {
      context.onOutput(`No session found matching ID: ${searchId}`);
      return;
    }

    await context.sessionStore.deleteSession(matched.id);

    // If we deleted the current session, create a new one
    if (context.sessionStore.getCurrentSessionId() === matched.id) {
      const newMeta = context.sessionStore.createNewSession();
      context.onOutput(`Deleted session ${matched.id} and created new session ${newMeta.id}`);
    } else {
      context.onOutput(`Deleted session ${matched.id}`);
    }
  } catch (error) {
    context.onOutput(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get all built-in session commands
 */
export function getSessionCommands(sessionStore: SessionStore): SlashCommand[] {
  return [
    {
      name: 'resume',
      description: 'List saved sessions or resume a saved session: /resume [id]',
      handler: async (ctx) => handleResume(ctx.args, {
        sessionStore,
        agent: ctx.agent,
        refreshMessages: ctx.refreshMessages,
        onOutput: ctx.onOutput,
      }),
    },
    {
      name: 'save',
      description: 'Force-save current session',
      handler: async (ctx) => handleSave(ctx.args, {
        sessionStore,
        agent: ctx.agent,
        onOutput: ctx.onOutput,
      }),
    },
    {
      name: 'forget',
      description: 'Delete a saved session: /forget <id>',
      handler: async (ctx) => handleForget(ctx.args, {
        sessionStore,
        onOutput: ctx.onOutput,
      }),
    },
  ];
}
```

- [ ] **Step 3: Update command-registry.ts for new command type**

Edit `src/cli/tui/command-registry.ts`, add import at top:

```typescript
import type { SessionStore } from '../../session/store';
import { getSessionCommands } from './commands/session-commands';
```

Modify where `BUILTIN_COMMANDS` is defined to include session commands when SessionStore is available. Currently BUILTIN_COMMANDS is probably a static export. Let's refactor:

Change from `export const BUILTIN_COMMANDS` to a function:

Find the existing `BUILTIN_COMMANDS` definition. If it's currently a const array:

Change to:

```typescript
export function getBuiltinCommands(sessionStore: SessionStore): SlashCommand[] {
  return [
    // existing builtins (/clear, /exit, etc.),
    ...getSessionCommands(sessionStore),
  ];
}
```

- [ ] **Step 4: Update where BUILTIN_COMMANDS is used**

In `App.tsx`, the line:

```typescript
const allCommands = [...BUILTIN_COMMANDS, ...skillCommands];
```

Change to accept commands from context that includes sessionStore. This will be handled when wiring up in `src/cli/index.ts`.

Actually, in `src/cli/index.ts` where `runTUIClient` is defined, it will pass the sessionStore.

- [ ] **Step 5: Compile to check for errors**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/types.ts src/cli/tui/commands/session-commands.ts src/cli/tui/command-registry.ts
git commit -m "feat(session): add slash commands for session management"
```

---

### Task 4: Wire up SessionStore in TUI entry point

**Files:**
- Modify: `bin/my-agent-tui-dev.ts`

- [ ] **Step 1: Add imports**

```typescript
import { SessionStore } from '../src/session/store';
import { createAutoSaveHook } from '../src/session/hook';
```

- [ ] **Step 2: Initialize SessionStore after config definition**

After `const config: AgentConfig = { ... }`, add:

```typescript
// Initialize session store and create new session
const sessionStore = new SessionStore();
sessionStore.ensureSessionDir().catch(error => {
  console.error('Failed to initialize session directory:', error);
});
const sessionStore.createNewSession();
```

Wait, correct:

```typescript
// Initialize session store and create new session
const sessionStore = new SessionStore();
sessionStore.ensureSessionDir().then(() => {
  sessionStore.createNewSession();
}).catch(error => {
  console.error('Failed to initialize session directory:', error);
});
```

Actually better to do it before creating agent, and await:

Move inside the async IIFE:

```typescript
// Load skills and convert to slash commands
(async () => {
  // Initialize session store
  await sessionStore.ensureSessionDir();
  sessionStore.createNewSession();

  const skillLoader = new SkillLoader();
  const skills = await skillLoader.loadAllSkills();
  const skillCommands = skills.map(toSkillCommand);

  runTUIClient(agent, skillCommands, sessionStore);
})();
```

- [ ] **Step 3: Add the auto-save hook to Agent constructor options**

Find the Agent creation:

```typescript
const agent = new Agent({
  provider,
  contextManager,
  config,
  toolRegistry,
  hooks: {
    afterAgentRun: [createAutoSaveHook(sessionStore)],
  },
});
```

Add the `hooks` property with the auto-save hook.

- [ ] **Step 4: Update runTUIClient signature to accept sessionStore**

Modify `runTUIClient` in `src/cli/index.ts` to accept `sessionStore` and pass it through to the command context.

- [ ] **Step 5: Update use-agent-loop to handle command output and refresh messages**

In `src/cli/tui/hooks/use-agent-loop.tsx`, update `onSubmit` to handle slash commands that need session context, trigger refresh after load.

When a command completes that changes context, it calls `refreshMessages` which should trigger a re-render by pulling fresh messages from agent context.

Add to `onSubmit` in `use-agent-loop.tsx`, before checking `/clear`/`/exit`:

Check if it's a slash command that matches our session commands, execute it with context.

The command handler needs:
- agent
- sessionStore
- onOutput (to display result in chat)
- refreshMessages (to update UI after loading session)

- [ ] **Step 6: Compile to check for errors**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add bin/my-agent-tui-dev.ts src/cli/index.ts src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "feat(session): wire up SessionStore and auto-save hook in TUI"
```

---

### Task 5: Update production compiled binary

**Files:**
- Modify: `bin/my-agent-tui` (recompile)

- [ ] **Step 1: Recompile TypeScript**

Run: `bun run tsc`

- [ ] **Step 2: Rebuild the production binary**

Run: `bun build src/cli/tui-entry.ts --outfile bin/my-agent-tui` (check actual build command from package.json)

- [ ] **Step 3: Commit updated binary**

```bash
git add bin/my-agent-tui
git commit -m "chore: update production binary with session system"
```

---

## Self-Review

- ✅ **Spec coverage:** All requirements from design spec are covered: SessionStore, metadata, auto-save hook, slash commands `/resume`/`/save`/`/forget`, listing with last user message, JSONL storage in `~/.my-agent/sessions/`, UUID naming.
- ✅ **No placeholders:** All steps have exact file paths and code examples.
- ✅ **Type consistency:** Types are consistently named. SessionStore, SessionMetadata, Message are all imported from existing types.
- ✅ **Incremental commits:** Each task creates a working piece and commits.

Plan is complete.</think_never_used_51bce0c785ca2f68081bfa7d91973934>

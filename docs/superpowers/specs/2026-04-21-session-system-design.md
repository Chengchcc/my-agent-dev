# Session System Design

*Date: 2026-04-21*
*Goal: Implement persistent session storage with JSONL, supporting restore to agent context*

## Overview

This feature adds persistent conversation sessions to the TUI. Sessions are auto-saved after each turn in JSONL format (one message per line) to `~/.my-agent/sessions/`, and can be loaded back using the `/resume` slash command.

## Architecture

### 1. SessionStore Class (`src/session/store.ts`)

Core storage class that handles all file operations:

```typescript
export interface SessionMetadata {
  id: string;
  createdAt: string;  // ISO date
  updatedAt: string;  // ISO date
  messageCount: number;
  lastUserMessage: string;  // Preview for listing
}

export class SessionStore {
  private sessionDir: string;
  private currentSessionId: string | null = null;

  constructor();
  getSessionDir(): string;
  ensureSessionDir(): Promise<void>;

  // Create new session
  createNewSession(): SessionMetadata;

  // Save full conversation (all messages)
  saveSession(sessionId: string, messages: Message[]): Promise<void>;

  // Load all messages from session
  loadSession(sessionId: string): Promise<Message[]>;

  // List all sessions sorted by updatedAt (newest first)
  listSessions(): Promise<SessionMetadata[]>;

  // Delete a session (both jsonl and json files)
  deleteSession(sessionId: string): Promise<void>;

  // Get current session ID
  getCurrentSessionId(): string | null;

  // Set current session ID
  setCurrentSessionId(id: string): void;
}
```

### 2. File Layout

- Storage location: `~/.my-agent/sessions/{sessionId}.jsonl`
- Metadata: `~/.my-agent/sessions/{sessionId}.json`

Each session has two files:
- `.jsonl` contains one JSON `Message` object per line
- `.json` contains metadata for quick listing without parsing all messages

### 3. Auto-save Hook

An `afterAgentRun` hook that:
- Gets the current session ID
- Gets all messages from agent context
- Calls `sessionStore.saveSession()` to persist
- Updates metadata with `updatedAt` and `lastUserMessage`

This is injected when creating the Agent in the TUI entry point.

### 4. Slash Commands (registered in TUI)

| Command | Description |
|---------|-------------|
| `/resume` | List all recent sessions (newest first), shows ID, date, last user message snippet |
| `/resume <id>` | Load the specified session: clears current context, adds all loaded messages to context |
| `/save` | Force-save current session (mostly redundant with auto-save, provided for completeness) |
| `/forget <id>` | Delete the specified session from disk |

### 5. Behavior

- On TUI startup: a new session is automatically created with auto-generated UUID
- After every agent turn completes: auto-save all messages to current session
- When loading a session: existing context is cleared, all messages from the saved session are added
- Session listing is sorted by `updatedAt` descending (newest changed first)
- The `lastUserMessage` in metadata stores the most recent user message for preview in the list

## Design Decisions

### Why rewrite entire file every time instead of appending?

- Simpler implementation - don't need to track which messages are already written
- Typical conversation size is small enough (hundreds of messages) that rewriting is still instant
- Avoids issues where messages get removed due to context compression but still exist in the JSONL file

### Why separate metadata file?

- Allows listing sessions without parsing the entire JSONL file
- Metadata (especially `lastUserMessage` preview) can be read quickly
- Keeps JSONL clean with just the messages

### Why UUID for filenames?

- Avoids filename collisions
- No issues with special characters in timestamps
- UUID v4 is easy to generate with the `crypto` module

## Integration Points

1. **TUI Entry Point** (`bin/my-agent-tui-dev.ts`): Create SessionStore, add auto-save hook to Agent
2. **Command Registry** (`src/cli/tui/command-registry.ts`): Register the four slash commands
3. **use-agent-loop Hook** (`src/cli/tui/hooks/use-agent-loop.tsx`): Handle command execution that modifies messages/context

## Error Handling

- If session directory doesn't exist: create it on first access
- If a session file is corrupted: skip it in listing and log a warning
- If session load fails: display error to user in chat
- Handle permission errors when writing to home directory gracefully with user-facing error message

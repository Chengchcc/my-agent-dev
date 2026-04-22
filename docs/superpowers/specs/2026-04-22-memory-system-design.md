# Memory System Design Specification

Agent 跨对话持久化记忆系统。

## 1. Overview

### 1.1 Purpose

解决当前问题：每次对话重启后，agent 完全忘记之前对话中学到的用户偏好、项目知识、决策结果。**Memory = 跨对话持久化的提炼知识**，让 agent 越用越懂用户。

### 1.2 Three Memory Types

| Type | Purpose | Lifetime | Scope | Example |
|------|---------|----------|-------|---------|
| **Semantic Memory** | Long-term user preferences, habits, facts | Permanent, cross-project | Global user-level | "prefers pnpm over npm", "uses vitest, not jest", "code style: functional" |
| **Episodic Memory** | Recent work history, key outcomes | Time-decaying, newest first | Global user-level | "refactored agent.ts into 3 files", "fixed ChatMessage markdown bugs" |
| **Project Memory** | Project-specific structure and conventions | Bound to project directory | Local project-level | "stack: TypeScript + Bun + Ink", "structure: src/agent/, src/cli/" |

### 1.3 Boundaries vs Session

| Aspect | Session | Memory |
|--------|---------|--------|
| What | Full raw conversation history | Extracted distilled knowledge |
| Scope | Single conversation session | Across all conversations |
| Purpose | Resume interrupted conversation | Inject relevant knowledge into new conversations |
| Access | Load entire session for recovery | Retrieve top-N relevant entries for injection |

**结论：** 没有重复设计，两者职责互补。Session 保持现有实现不变，Memory 新增互补功能。

## 2. Architecture

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    Agent Loop                               │
 │                                                              │
 │  ┌─────────────────────────────────────────────────────┐   │
 │  │         MemoryMiddleware (beforeModel)              │   │
 │  │         • Extract query from last user message      │   │
 │  │         • Retrieve relevant memories via Retriever  │   │
 │  │         • Inject into system prompt <memory> tag    │   │
 │  └───────────────────────┬─────────────────────────────┘   │
 │                          ↓                                 │
 │  ┌───────────────────────┴───────────────────────┐        │
 │  │  MemoryStores                                 │        │
 │  │  • SemanticStore  (global ~/.my-agent/memory)  │        │
 │  │  • EpisodicStore  (global)                     │        │
 │  │  • ProjectStore  (local .claude/project.json)  │        │
 │  └────────────────────────────────────────────────┘        │
 │                                                             │
 │  After agent run completes (no more tool calls):           │
 │  ┌───────────────────────┐                                 │
 │  │    MemoryExtractor    │  • Async extraction with cheap  │
 │  │  (afterAgentRun)      │    LLM (Haiku)                 │
 │  │                       │  • Deduplicate & consolidate    │
 │  │                       │  • Write to stores              │
 │  └───────────────────────┘                                 │
 │                                                             │
 │  Agent can invoke at any time:                              │
 │  ┌─────────────────┐                                        │
 │  │   Memory Tool   │  • search: find relevant memories     │
 │  │   (ToolImpl)    │  • add: store new memory              │
 │  │                 │  • list: list recent memories         │
 │  │                 │  • forget: delete specific memory    │
 │  │                 │  • consolidate: trigger deduplication│
 │  └─────────────────┘                                        │
 │                                                             │
 └─────────────────────────────────────────────────────────────┘
```

### 2.1 Core Interfaces (extensible)

All components are defined via interfaces for future replacement. See `src/memory/types.ts`:

```typescript
export interface MemoryEntry {
  id: string;                      // Unique UUID
  type: 'semantic' | 'episodic' | 'project';
  text: string;                    // Memory content
  tags?: string[];                 // Classification tags
  created: string;                 // ISO creation time
  updated?: string;                // ISO last update
  weight: number;                  // 0-1 confidence/importance
  source: 'explicit' | 'implicit' | 'user';  // Origin
  projectPath?: string;            // Associated project path
  files?: string[];                // Associated files
  metadata?: Record<string, unknown>; // Extensions
}

export interface MemoryStore {
  add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null>;
  remove(id: string): Promise<boolean>;
  getAll(): Promise<MemoryEntry[]>;
  getByType(type: MemoryEntry['type']): Promise<MemoryEntry[]>;
  replaceAll(entries: MemoryEntry[], type: MemoryEntry['type']): Promise<void>;
  count(type?: MemoryEntry['type']): Promise<number>;
  getRecent(limit: number, type?: MemoryEntry['type']): Promise<MemoryEntry[]>;
}

export interface MemoryRetriever {
  search(query: string, options?: { limit?: number; projectPath?: string }): Promise<MemoryEntry[]>;
}

export interface MemoryExtractor {
  extract(messages: Message[], projectPath?: string): Promise<MemoryEntry[]>;
  consolidate(entries: MemoryEntry[]): Promise<MemoryEntry[]>;
}
```

### 2.2 Storage Layout (Hybrid)

| Memory Type | Location |
|-------------|----------|
| Semantic | `~/.my-agent/memory/semantic.jsonl` (global) |
| Episodic | `~/.my-agent/memory/episodic.jsonl` (global) |
| Project | `{cwd}/.claude/memory-project.json` (local) |

All storage is plain text files, no external database required. Easy to debug with `grep`/`jq`.

## 3. Memory Retrieval (V1)

V1 uses **keyword + recency hybrid scoring** (no embeddings, no external dependencies):

```typescript
score =
  keywordMatch(query, entry.text) * 0.4 +
  tagMatch(query, entry.tags) * 0.3 +
  recencyScore(entry.created) * 0.2 +
  entry.weight * 0.1
```

Top 10 entries sorted by score injected into system prompt.

**Future V2:** Can replace `MemoryRetriever` implementation with embedding-based semantic search without changing any other code.

## 4. Memory Extraction

### 4.1 Trigger Conditions (hybrid from user feedback)

Automatic extraction runs **only when**:
1. Last model output contains **no tool calls** → current task completed
2. Total tool calls in current session ≥ 3 → meaningful work done
3. Runs asynchronously, does not block user input

### 4.2 Extraction Prompt (cheap model = Haiku)

```
Analyze this conversation and extract:
1. User preferences or habits (e.g. "prefers X over Y")
2. Facts about the current project (e.g. "uses TypeScript with Bun")
3. Key decisions made (e.g. "decided to use vitest")
4. Important outcomes (e.g. "refactored agent.ts into 3 files")

Rules:
- Only extract genuinely useful, reusable information
- Skip transient/one-time things
- Each entry should be a single, clear statement
- Return JSON array of {type, text, tags, weight}
- If nothing worth remembering, return []
```

### 4.3 Consolidation (Deduplication)

- Trigger: When semantic memory entries exceed 50 → auto-consolidate
- Algorithm: LLM reads all entries, merges duplicates, resolves conflicts, removes outdated entries
- Capacity limit: Semantic max 200 entries, Episodic max 500 entries → FIFO淘汰 when exceeded

## 5. Memory Injection Format

Memories are injected into `systemPrompt` in `beforeModel` hook before every model call:

```xml
<memory>
## User Preferences (Relevant)
- Prefers pnpm over npm for package installation
- Uses vitest instead of jest for testing
- Code style prefers functional composition over classes

## Current Project: my-agent
- Path: /root/my-agent
- Stack: TypeScript 6, Bun, Ink 5, React
- Structure: src/agent/, src/providers/, src/cli/tui/, src/tools/
- Conventions: ESM modules, strict TypeScript

## Recent Work
- 2026-04-21: Implemented SubAgentTool for delegating tasks
- 2026-04-20: Added AskUserQuestion tool for user choices
</memory>
```

## 6. Memory Tool (Agent API)

Agent can actively read/write memory at any time via the `memory` tool:

| Command | Purpose |
|---------|---------|
| `search {query}` | Find relevant memories for a topic |
| `add {text} [type]` | Store a new reusable memory |
| `list [type] [limit]` | List recent memories |
| `forget {id}` | Delete a specific memory |
| `consolidate` | Manually trigger deduplication |

## 7. File Structure

By layer (per user decision):

```
src/memory/
├── types.ts        # Core interfaces: MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor
├── store.ts        # JsonlMemoryStore implements MemoryStore (JSONL file storage)
├── retriever.ts    # KeywordRetriever implements MemoryRetriever (keyword + recency)
├── extractor.ts    # LlmExtractor implements MemoryExtractor (LLM extraction + consolidation)
├── middleware.ts   # MemoryMiddleware implements AgentMiddleware (injection + auto-extract)
├── tool.ts         # MemoryTool implements ToolImplementation (agent active access)
└── index.ts        # Public exports
```

## 8. Integration with Existing Code

| File | Change |
|------|--------|
| `src/agent/Agent.ts` | No changes - Memory uses existing hooks system |
| `src/types.ts` | No changes - Memory defines own types in `src/memory/types.ts` |
| `src/session/` | No changes - Session stays independent |
| `bin/my-agent-tui-dev.ts` | Register MemoryMiddleware and MemoryTool on startup |

## 9. Implementation Priority

| Phase | Content | Complexity |
|-------|---------|------------|
| P0 | Core types + JsonlMemoryStore | Low |
| P0 | KeywordRetriever search implementation | Low |
| P0 | MemoryMiddleware with injection | Low |
| P0 | MemoryTool (search/add/list/forget) | Low |
| P1 | LlmExtractor with automatic extraction | Medium |
| P1 | LLM-based consolidation | Low |
| P1 | Project memory auto-scanning | Medium |
| P2 | Slash commands for TUI (/memory list, /memory forget) | Low |

## 10. Privacy & Limits

| Constraint | Implementation |
|------------|----------------|
| User isolation | Global storage in `~/.my-agent/memory/` per user |
| No sensitive data | Extraction prompt explicitly instructs to skip API keys/passwords |
| User control | `memory list` / `memory forget` for full user control |
| Capacity caps | Semantic: 200 entries max, Episodic: 500 entries max (FIFO) |

## 11. Decision Record

| Decision | Chosen Option | Reason |
|----------|---------------|--------|
| Storage location | Hybrid | Semantic global, Project local |
| Extraction timing | Hybrid: after task completion (no tool calls + ≥3 tool calls) | Balances cost and freshness |
| Deduplication | LLM-based consolidation | Better quality than pure rule-based |
| Retrieval V1 | Keyword + recency only | No dependencies, ship quickly |
| Code structure | By layer | Clean separation, follows existing project patterns |
| Session integration | Fully independent | Session keeps its own purpose, no cross-coupling |

# Magic Number & String Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all magic numbers and closed-set string literals from the codebase, then install 4-layer anti-corruption: ESLint, CI, Architecture Constitution, and `check:arch` duplicate detection.

**Architecture:** Co-locate constants with consuming code (existing convention). Cross-file duplicates extracted to shared locations. ESLint `no-magic-numbers` blocks new occurrences. CI workflow enforces quality gates on PR. `check:arch` detects cross-file literal duplication.

**Tech Stack:** TypeScript + Bun, ESLint v9 flat config, custom ts-morph architecture checker, GitHub Actions

---

### Task 1: Extract DJB2 hash to shared utility

**Files:**
- Create: `src/utils/hash.ts`
- Modify: `src/memory/middleware.ts:221-228`
- Modify: `src/skills/middleware.ts:216-224`

- [ ] **Step 1: Create `src/utils/hash.ts` with shared DJB2 hash function**

```typescript
const DJB2_INITIAL_HASH = 5381;

/** Simple DJB2 hash for content-based versioning (memory preferences, skill catalog). */
export function djb2Hash(text: string): string {
  let hash = DJB2_INITIAL_HASH;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
```

- [ ] **Step 2: Replace inline hash in `src/memory/middleware.ts`**

Replace lines 221-228 (the `hashText` function) with:

```typescript
import { djb2Hash } from '../utils/hash';

// ... delete the hashText function, update call site on line 242:
const hash = djb2Hash(JSON.stringify(preferences));
```

Wait — read the actual call site first. Line 242 references `hashText` in a different context. Let me check the exact usage.

- [ ] **Step 2 (revised): Replace inline hash in `src/memory/middleware.ts`**

Read the full file to find all `hashText` call sites. Replace the function definition (lines 221-228) and all call sites to use `djb2Hash` from `../utils/hash.js`.

- [ ] **Step 3: Replace inline hash in `src/skills/middleware.ts`**

Lines 216-224: Replace the `hashCatalog` function body to call `djb2Hash` from `../utils/hash.js`:

```typescript
import { djb2Hash } from '../utils/hash';

// In hashCatalog, replace the inline hash loop:
function hashCatalog(entries: Array<{ name: string; description: string; path: string }>): string {
  const text = JSON.stringify(entries);
  return djb2Hash(text);
}
```

- [ ] **Step 4: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/hash.ts src/memory/middleware.ts src/skills/middleware.ts
git commit -m "refactor: extract shared DJB2 hash to src/utils/hash.ts"
```

---

### Task 2: Extract shared config constants (maxTokens, temperature, model names)

**Files:**
- Create: `src/config/constants.ts`
- Modify: `src/config/defaults.ts:7-8,28,46`
- Modify: `src/providers/claude.ts:30,32`
- Modify: `src/providers/openai.ts:23-24`
- Modify: `src/providers/index.ts:45`
- Modify: `src/runtime.ts:94,102,255,280`
- Modify: `src/memory/extractor.ts:8`

- [ ] **Step 1: Create `src/config/constants.ts`**

```typescript
// --- Token defaults ---
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TOKEN_LIMIT = 180_000;
export const DEFAULT_THINKING_BUDGET = 8000;
export const DEFAULT_COMPACTION_BUFFER = 2048;
export const DEFAULT_MAX_SUMMARY_TOKENS = 1024;

// --- Model defaults ---
export const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
export const DEFAULT_SUMMARY_MODEL = 'claude-3-5-haiku-20241022';

// --- LLM defaults ---
export const DEFAULT_TEMPERATURE = 0.7;
```

- [ ] **Step 2: Update `src/config/defaults.ts` to use constants**

```typescript
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_TOKEN_LIMIT,
} from './constants';

export const defaultSettings: Settings = {
  llm: {
    provider: 'claude',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    // ...
  },
  context: {
    tokenLimit: DEFAULT_TOKEN_LIMIT,
    compaction: {
      // ...
      summaryModel: DEFAULT_SUMMARY_MODEL,
      maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
      // ...
    },
  },
  // ...
};
```

- [ ] **Step 3: Update `src/providers/claude.ts`**

Replace inline `0.7` and `8000` with imports from `../config/constants.js`:
- Line 30: `temperature: 0.7` → `temperature: DEFAULT_TEMPERATURE`
- Line 32: `thinkingBudget: 8000` → `thinkingBudget: DEFAULT_THINKING_BUDGET`

- [ ] **Step 4: Update `src/providers/openai.ts`**

Replace inline `4096` and `0.7`:
- Line 23: `maxTokens: 4096` → `maxTokens: DEFAULT_MAX_TOKENS`
- Line 24: `temperature: 0.7` → `temperature: DEFAULT_TEMPERATURE`

- [ ] **Step 5: Update `src/providers/index.ts` line 45**

Replace inline `8000` → `DEFAULT_THINKING_BUDGET` imported from `../config/constants.js`.

- [ ] **Step 6: Update `src/runtime.ts`**

Replace inline values:
- Line 94: `4096` → `DEFAULT_MAX_TOKENS`
- Line 102: `2048` → `DEFAULT_COMPACTION_BUFFER`
- Line 255: `4096` → `DEFAULT_MAX_TOKENS`
- Line 280: `'claude-3-5-sonnet-20241022'` → `DEFAULT_MODEL`

- [ ] **Step 7: Update `src/memory/extractor.ts` line 8**

Replace `'claude-3-5-haiku-20241022'` → `DEFAULT_SUMMARY_MODEL` imported from `../config/constants.js`.

- [ ] **Step 8: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 9: Commit**

```bash
git add src/config/constants.ts src/config/defaults.ts src/providers/claude.ts src/providers/openai.ts src/providers/index.ts src/runtime.ts src/memory/extractor.ts
git commit -m "refactor: extract shared config constants (maxTokens, temperature, models)"
```

---

### Task 3: Extract magic numbers in `src/agent/` (budget-guard, loop-types, rate-limiter, sub-agent-tool)

**Files:**
- Modify: `src/agent/budget-guard.ts:37-81`
- Modify: `src/agent/loop-types.ts:207-210`
- Modify: `src/agent/rate-limiter.ts:23,56-57`
- Modify: `src/agent/sub-agent-tool.ts:315,91`
- Modify: `src/agent/tool-dispatch/middlewares/read-cache.ts:9`
- Modify: `src/agent/tool-dispatch/middlewares/permission.ts:58`
- Modify: `bin/my-agent.ts:14,222`

- [ ] **Step 1: Extract budget-guard tool output estimates (`src/agent/budget-guard.ts`)**

Replace the inline numbers in `estimateToolOutput` (lines 37-81) with a named lookup table:

```typescript
/** Estimated token output for each tool type. */
const TOOL_OUTPUT_ESTIMATES = {
  read: {
    baseOverhead: 100,
    defaultUnknown: 3000,
    charsPerToken: 4,
    tokensPerLine: 80,
  },
  grep: 3000,
  glob: 1000,
  ls: 500,
  bash: {
    cat: 5000,
    find: 3000,
    trivial: 100,
    general: 2000,
  },
  textEditor: 1500,
  memory: 1500,
  subAgent: 1500,
  default: 1000,
} as const;

export function estimateToolOutput(toolCall: ToolCall): number {
  const name = toolCall.name;
  const EST = TOOL_OUTPUT_ESTIMATES;

  switch (name) {
    case 'read': {
      const limit = typeof toolCall.arguments.limit === 'number' ? toolCall.arguments.limit : 0;
      if (limit > 0) {
        return Math.ceil((limit * EST.read.tokensPerLine) / EST.read.charsPerToken) + EST.read.baseOverhead;
      }
      return EST.read.defaultUnknown;
    }
    case 'grep': return EST.grep;
    case 'glob': return EST.glob;
    case 'ls': return EST.ls;
    case 'bash': {
      const command = (toolCall.arguments.command as string || '').toLowerCase();
      if (command.includes('cat ') || command.includes('less ') || command.includes('head ') || command.includes('tail ')) {
        return EST.bash.cat;
      }
      if (command.includes('find ') || command.includes('grep ')) {
        return EST.bash.find;
      }
      if (command.includes('wc ') || command.includes('echo ') || command.includes('pwd ')) {
        return EST.bash.trivial;
      }
      return EST.bash.general;
    }
    case 'text-editor': return EST.textEditor;
    case 'memory': return EST.memory;
    case 'sub_agent': return EST.subAgent;
    default: return EST.default;
  }
}
```

- [ ] **Step 2: Extract `AgentLoopConfig` timeout constants (`src/agent/loop-types.ts`)**

Replace lines 206-214:

```typescript
export const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TOOL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100 * 1024; // 100KB

export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  maxTurns: DEFAULT_MAX_TURNS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  maxToolOutputChars: DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  parallelToolExecution: true,
  yieldEventsAsToolsComplete: true,
  toolErrorStrategy: 'continue',
};
```

- [ ] **Step 3: Extract rate-limiter constants (`src/agent/rate-limiter.ts`)**

Replace inline values:
- Line 23: `1000` → `const MS_PER_SECOND = 1000;` and use it
- Line 56: `5` → `const DEFAULT_RPS = 5;`
- Line 57: `3` → `const MIN_BURST_SIZE = 3;`

- [ ] **Step 4: Extract sub-agent constants (`src/agent/sub-agent-tool.ts`)**

- Line 315: `5 * 60 * 1000` → `const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000;`
- Line 91 (JSDoc) and 264: replace `50000` with `const DEFAULT_SUB_AGENT_TOKEN_LIMIT = 50_000;`

Also sync `bin/my-agent.ts` line 14 — change `25` to import `DEFAULT_MAX_TURNS` from `../agent/loop-types.js` or define `const CLI_DEFAULT_MAX_TURNS = DEFAULT_MAX_TURNS;`.

- [ ] **Step 5: Extract read-cache and permission constants**

`src/agent/tool-dispatch/middlewares/read-cache.ts` line 9:
```typescript
const READ_CACHE_MAX_ENTRIES = 100;
```

`src/agent/tool-dispatch/middlewares/permission.ts` line 58:
```typescript
const DANGEROUS_CMD_TRUNCATION_LENGTH = 80;
```

- [ ] **Step 6: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/budget-guard.ts src/agent/loop-types.ts src/agent/rate-limiter.ts src/agent/sub-agent-tool.ts src/agent/tool-dispatch/middlewares/ bin/my-agent.ts
git commit -m "refactor: extract magic numbers from agent module"
```

---

### Task 4: Extract magic numbers in `src/agent/compaction/`

**Files:**
- Modify: `src/agent/compaction/budget.ts:21-22,65`
- Modify: `src/agent/compaction/tiers/reactive.ts:29,45`
- Modify: `src/agent/compaction/tiers/auto-compact.ts:125-126`

- [ ] **Step 1: Extract compaction budget constants (`src/agent/compaction/budget.ts`)**

```typescript
const DEFAULT_COMPACTION_BUFFER = 2048;
const DEFAULT_EPHEMERAL_RESERVE = 1024;
const PER_MESSAGE_METADATA_OVERHEAD = 20;
```

Replace constructor defaults on lines 21-22 and the overhead on line 65.

- [ ] **Step 2: Extract reactive tier constants (`src/agent/compaction/tiers/reactive.ts`)**

```typescript
const AGGRESSIVE_SNIP_THRESHOLD = 2000;
const RECENT_MESSAGE_BOUNDARY = 4;
```

Replace line 29 and line 45.

- [ ] **Step 3: Extract auto-compact truncation constants (`src/agent/compaction/tiers/auto-compact.ts`)**

```typescript
const SUMMARY_MAX_CHARS = 3000;
const SUMMARY_TRIM_CHARS = 2000;
const SUMMARY_HEAD_CHARS = 500;
```

Replace lines 125-126.

- [ ] **Step 4: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/compaction/
git commit -m "refactor: extract magic numbers from compaction module"
```

---

### Task 5: Extract magic numbers in `src/tools/`

**Files:**
- Modify: `src/tools/bash.ts:39-40,77`
- Modify: `src/tools/read.ts:14-15`
- Modify: `src/tools/glob.ts:15-16`
- Modify: `src/tools/grep.ts:26`
- Modify: `src/tools/ls.ts:12-13`
- Modify: `src/tools/ask-user-question.ts:43-44`

- [ ] **Step 1: Extract bash tool constants (`src/tools/bash.ts`)**

```typescript
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CHILD_PROCESS_MAX_BUFFER = 10 * 1024 * 1024;
```

Replace lines 39, 40, 77.

- [ ] **Step 2: Extract read tool constants (`src/tools/read.ts`)**

```typescript
const DEFAULT_START_LINE = 1;
const DEFAULT_MAX_LINES = 500;
```

Replace lines 14-15.

- [ ] **Step 3: Extract glob tool constants (`src/tools/glob.ts`)**

```typescript
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_DEPTH = 30;
```

Replace lines 15-16.

- [ ] **Step 4: Extract grep tool constants (`src/tools/grep.ts`)**

```typescript
const DEFAULT_MAX_RESULTS = 100;
```

Replace line 26.

- [ ] **Step 5: Extract ls tool constants (`src/tools/ls.ts`)**

```typescript
const DEFAULT_LS_DEPTH = 1;
const MAX_LS_DEPTH = 5;
```

Replace lines 12-13.

- [ ] **Step 6: Extract ask-user-question constants (`src/tools/ask-user-question.ts`)**

```typescript
const MAX_TAB_LABEL_LENGTH = 12;
```

Replace lines 43-44.

- [ ] **Step 7: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/tools/
git commit -m "refactor: extract magic numbers from tool files"
```

---

### Task 6: Extract magic numbers in `src/cli/tui/`

**Files:**
- Modify: `src/cli/tui/utils/tool-format.ts:16-18,57-95,223-248`
- Modify: `src/cli/tui/hooks/use-terminal-width.ts:3-4,11`
- Modify: `src/cli/tui/hooks/use-command-input.ts:95-104,389`
- Modify: `src/cli/tui/paste-buffering-stdin.ts:143,160`
- Modify: `src/cli/tui/utils/syntax-cache.ts:7`
- Modify: `src/cli/tui/commands/diagnostic-commands.ts:17,49`
- Modify: `src/cli/tui/commands/session-commands.ts:17,20`
- Modify: `src/cli/tui/commands/compact-command.ts:18,22`

- [ ] **Step 1: Extract tool-format.ts constants**

Replace the inline truncation lengths and line thresholds with module-level constants:

```typescript
// Truncation lengths for tool call title display
const BASH_CMD_TRUNCATION = 80;
const SUB_AGENT_TASK_TRUNCATION = 60;
const GREP_PATTERN_TRUNCATION = 40;
const DEFAULT_ARG_TRUNCATION = 30;

// Result folding thresholds
const RESULT_COLLAPSIBLE_MIN_LINES = 3;
const ERROR_DISPLAY_LINES = 10;
const MEDIUM_RESULT_THRESHOLD = 20;
const LONG_RESULT_HEAD_LINES = 5;
const LONG_RESULT_TAIL_LINES = 3;

// Truncation ellipsis
const TRUNCATION_ELLIPSIS = '...';
```

Replace all inline numbers in `truncate`, `formatToolCallTitle`, `smartSummarize`, and `formatToolResult`.

- [ ] **Step 2: Extract use-terminal-width.ts constants**

```typescript
const DEFAULT_DEBOUNCE_MS = 50;
const FALLBACK_TERMINAL_WIDTH = 80;
```

- [ ] **Step 3: Extract use-command-input.ts constants**

```typescript
const AT_FILE_GLOB_DEPTH = 10;
const MAX_AT_FILE_RESULTS = 15;
const AT_FILE_DEBOUNCE_MS = 120;
const PASTE_FOLD_LINE_THRESHOLD = 3;
const PASTE_FOLD_CHAR_THRESHOLD = 200;
```

- [ ] **Step 4: Extract paste-buffering-stdin.ts constants**

```typescript
const PASTE_MARKER_ID_LENGTH = 6;
const DRAIN_TIMER_DELAY_MS = 50;
```

- [ ] **Step 5: Extract syntax-cache.ts constants**

```typescript
const SYNTAX_CACHE_KEY_PREVIEW_LENGTH = 64;
```

- [ ] **Step 6: Extract diagnostic-commands.ts and session-commands.ts constants**

```typescript
// diagnostic-commands.ts
const TOKEN_LIMIT_FALLBACK = 128_000;
const TOOL_DESC_TRUNCATION = 80;
const TOOL_DESC_MIN_WIDTH = 77;

// session-commands.ts
const SESSION_ID_PREFIX_LENGTH = 8;
const SESSION_PREVIEW_MAX_LENGTH = 60;
```

- [ ] **Step 7: Extract compact-command.ts constants**

The `100` used for percentage display is a conversion factor — it's universally understood and can stay as-is per the exemption list.

- [ ] **Step 8: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 9: Commit**

```bash
git add src/cli/tui/
git commit -m "refactor: extract magic numbers from TUI module"
```

---

### Task 7: Extract magic numbers in `src/memory/`

**Files:**
- Modify: `src/memory/middleware.ts:10-19,105-118,240`
- Modify: `src/memory/store.ts:11-20`
- Modify: `src/memory/retriever.ts:14,77-108`

- [ ] **Step 1: Extract memory middleware fallback constants (`src/memory/middleware.ts`)**

Replace lines 10-19 inline fallback defaults with named constants. Move the post-collapse multipliers (lines 105-118) into named values:

```typescript
// Fallback values (used when settings are not loaded)
const FALLBACK_MAX_SEMANTIC_ENTRIES = 200;
const FALLBACK_MAX_EPISODIC_ENTRIES = 500;
const FALLBACK_CONSOLIDATION_THRESHOLD = 50;
const FALLBACK_AUTO_EXTRACT_MIN_TOOL_CALLS = 3;
const FALLBACK_MAX_INJECTED_ENTRIES = 10;
const FALLBACK_RETRIEVAL_THRESHOLD = 0.75;
const FALLBACK_RETRIEVAL_TOP_K = 5;
const FALLBACK_MAX_USER_PREFERENCES = 20;

// Post-collapse behavior multipliers
const POST_COLLAPSE_RETRIEVAL_MULTIPLIER = 2;
const POST_COLLAPSE_PROJECT_MULTIPLIER = 2;
const RECENT_USER_TURN_COUNT = 3;
```

- [ ] **Step 2: Deduplicate store.ts fallbacks**

`src/memory/store.ts` lines 11-20 duplicate the same fallback values. Import from `middleware.js` or extract to a shared location. Replace inline values with the named constants:

```typescript
import { FALLBACK_MAX_SEMANTIC_ENTRIES, FALLBACK_MAX_EPISODIC_ENTRIES, ... } from './middleware';
```

If circular imports are a concern, extract fallback constants to `src/memory/constants.ts` and import from both files.

- [ ] **Step 3: Extract retriever scoring constants (`src/memory/retriever.ts`)**

Replace the scoring weights (lines 104-108) and recency decay (lines 97-99):

```typescript
// Scoring weights (must sum to 1.0)
const KEYWORD_WEIGHT = 0.4;
const TAG_WEIGHT = 0.3;
const RECENCY_WEIGHT = 0.2;
const INTRINSIC_WEIGHT = 0.1;

// Recency calculation
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const RECENCY_HALF_LIFE_DAYS = 30;
```

Replace lines 14 defaults:
```typescript
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_THRESHOLD = 0.1;
```

- [ ] **Step 4: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/
git commit -m "refactor: extract magic numbers from memory module"
```

---

### Task 8: Extract magic numbers in `src/providers/`, `src/runtime.ts`, `src/skills/`, `src/todos/`, `src/session/`, `src/utils/`, `bin/`

**Files:**
- Modify: `src/skills/middleware.ts:21-22`
- Modify: `src/todos/todo-middleware.ts:8-10`
- Modify: `src/session/store.ts:108`
- Modify: `src/utils/is-text-file.ts:21,26-27,30`
- Modify: `bin/my-agent.ts:222`
- Modify: `bin/my-agent-tui:79,89`

- [ ] **Step 1: Extract skills middleware constants (`src/skills/middleware.ts`)**

Lines 21-22 already use named constants `DEFAULT_MAX_INJECTED_SKILLS` and `DEFAULT_MAX_DESCRIPTION_LENGTH`. No changes needed beyond the DJB2 fix from Task 1.

- [ ] **Step 2: Extract todo middleware constants (`src/todos/todo-middleware.ts`)**

Lines 8-10 already use `REMINDER_CONFIG` with named fields. No changes needed.

- [ ] **Step 3: Extract session store constants (`src/session/store.ts`)**

```typescript
const SESSION_PREVIEW_MAX_LENGTH = 100;
```

Replace line 108.

- [ ] **Step 4: Extract is-text-file.ts constants (`src/utils/is-text-file.ts`)**

```typescript
const BINARY_CHECK_BUFFER_SIZE = 1024;
```

Replace lines 21, 26, 27, 30 (all 4 occurrences of `1024`).

- [ ] **Step 5: Extract remaining bin/ constants**

`bin/my-agent.ts` line 222: `2` for JSON indentation → `const JSON_INDENT = 2;`

`bin/my-agent-tui` lines 79, 89: already addressed in Task 2 (use shared config constants).

- [ ] **Step 6: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 7: Commit**

```bash
git add src/session/ src/utils/ bin/
git commit -m "refactor: extract remaining magic numbers from misc modules"
```

---

### Task 9: Extract closed-set string literals to `as const` arrays

**Files:**
- Modify: `src/agent/budget-guard.ts` (BudgetAction type)
- Modify: `src/agent/loop-types.ts` (SubAgentExitStatus, ToolErrorStrategy)
- Modify: `src/agent/sub-agent-tool.ts` (SubAgentProfile, SubAgentDeliverable)
- Modify: `src/tools/permission-manager.ts` (PermissionResponse)
- Modify: `src/memory/types.ts` (MemoryType)
- Modify: `src/todos/types.ts` (TodoStatus)
- Modify: `src/config/types.ts` (provider, extractTriggerMode)

- [ ] **Step 1: Extract `SubAgentProfile` and `SubAgentDeliverable` as const arrays (`src/agent/sub-agent-tool.ts`)**

```typescript
export const SUB_AGENT_PROFILES = ['read_only', 'code_editor', 'general'] as const;
export type SubAgentProfile = (typeof SUB_AGENT_PROFILES)[number];

export const SUB_AGENT_DELIVERABLES = ['summary', 'file_list', 'code_patch', 'structured_json'] as const;
export type SubAgentDeliverable = (typeof SUB_AGENT_DELIVERABLES)[number];
```

Replace inline string literals in `profile` check logic with references to the array.

- [ ] **Step 2: Extract other closed sets**

Apply the same pattern everywhere a string union type exists with a closed set:

```typescript
// src/agent/loop-types.ts
export const SUB_AGENT_EXIT_STATUSES = ['success', 'timeout', 'max_turns', 'error', 'aborted'] as const;
export type SubAgentExitStatus = (typeof SUB_AGENT_EXIT_STATUSES)[number];

export const TOOL_ERROR_STRATEGIES = ['continue', 'halt'] as const;
export type ToolErrorStrategy = (typeof TOOL_ERROR_STRATEGIES)[number];

// src/agent/budget-guard.ts
export const BUDGET_ACTIONS = ['proceed', 'delegate-to-sub-agent', 'compact-first'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

// src/tools/permission-manager.ts
export const PERMISSION_RESPONSES = ['allow', 'deny', 'always'] as const;
export type PermissionResponse = (typeof PERMISSION_RESPONSES)[number];

// src/memory/types.ts
export const MEMORY_TYPES = ['semantic', 'episodic', 'project'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

// src/todos/types.ts
export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
```

- [ ] **Step 3: Run tests and lint**

```bash
bun test
bun run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/budget-guard.ts src/agent/loop-types.ts src/agent/sub-agent-tool.ts src/tools/permission-manager.ts src/memory/types.ts src/todos/types.ts
git commit -m "refactor: extract closed-set string literals to const arrays"
```

---

### Task 10: Configure ESLint `no-magic-numbers` rule

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add `@typescript-eslint/no-magic-numbers` to eslint.config.js**

Add to the base TS config block (the first object in the array, between `max-lines` and the closing `}`):

```javascript
// In the rules object of the first config block:
'@typescript-eslint/no-magic-numbers': ['error', {
  ignore: [-1, 0, 1, 2],
  ignoreEnums: true,
  ignoreNumericLiteralTypes: true,
  ignoreReadonlyClassProperties: true,
  ignoreTypeIndexes: true,
}],
```

- [ ] **Step 2: Add exemptions for defaults.ts, schema.ts, and test files**

Add two new config blocks after the existing ones:

```javascript
// ===== Config defaults — values are self-documenting via key names =====
{
  files: ['src/config/defaults.ts', 'src/config/schema.ts'],
  rules: {
    '@typescript-eslint/no-magic-numbers': 'off',
  },
},

// ===== Test files — assertion values are self-documenting =====
{
  files: ['tests/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/no-magic-numbers': 'off',
  },
},
```

Note: tests already have a config block (the second one). Merge the `no-magic-numbers: 'off'` into the existing test block rather than creating a new one.

- [ ] **Step 3: Run lint to verify no false positives**

```bash
bun run lint
```

Expected: PASS with no new errors. If there are false positives (e.g., legitimate 0/1/2 usage that the ignore list doesn't cover), add `// eslint-disable-next-line no-magic-numbers` comments sparingly.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "feat: enable ESLint no-magic-numbers rule with exemptions"
```

---

### Task 11: Create CI workflow

**Files:**
- Create: `.github/workflows/check.yml`

- [ ] **Step 1: Create `.github/workflows/check.yml`**

```yaml
name: Quality Gates

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun run check:guard

      - name: Lint
        run: bun run lint

      - name: Tests
        run: bun test

      - name: Architecture checks
        run: bun run check:arch

      - name: Dead code check
        run: bun run check:deadcode
```

- [ ] **Step 2: Run the check:all command locally to verify it passes**

```bash
bun run check:all
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/check.yml
git commit -m "ci: add GitHub Actions quality gate workflow"
```

---

### Task 12: Update Architecture Constitution

**Files:**
- Modify: `ARCHITECTURE-CONSTITUTION.md`

- [ ] **Step 1: Add magic number rule to Section I (Forbidden Patterns)**

Add after line 57 (`// @ts-expect-error without justification comment`):

```markdown
- `@typescript-eslint/no-magic-numbers` violations — numeric literals (beyond -1/0/1/2) must be named constants. String literals that form a closed set must use `as const` arrays with derived types. Duplicate literal occurrences across files must be consolidated.
```

- [ ] **Step 2: Run check:all to verify no regressions**

```bash
bun run check:all
```

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE-CONSTITUTION.md
git commit -m "docs: add magic number governance rule to constitution"
```

---

### Task 13: Update `check:arch` script with duplicate literal detection

**Files:**
- Modify: `scripts/check-architecture.ts`
- Read: `scripts/check-architecture.ts` (full file for context)

- [ ] **Step 1: Read `scripts/check-architecture.ts` to understand current structure**

- [ ] **Step 2: Add duplicate literal detection**

Add a new check function that scans `src/` and `bin/` for numeric/string literals appearing in 2+ files:

```typescript
/**
 * Check for duplicate numeric and string literals across files.
 * Catches re-introduction of shared magic values.
 */
function checkDuplicateLiterals(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  // Known whitelist — values allowed to appear in multiple files
  const WHITELIST = new Set([
    '-1', '0', '1', '2',
    '100', '1000',
    'true', 'false',
    "''", '""',
  ]);

  const literalLocations = new Map<string, Array<{ file: string; line: number }>>();

  for (const file of [...sourceFiles, ...binFiles]) {
    const src = readFileSync(file, 'utf-8');
    const sourceFile = project.addSourceFileAtPath(file);

    // Collect numeric literals
    sourceFile.forEachDescendant(node => {
      if (Node.isNumericLiteral(node)) {
        const val = node.getText();
        if (!WHITELIST.has(val)) {
          const locs = literalLocations.get(val) ?? [];
          locs.push({ file, line: node.getStartLineNumber() });
          literalLocations.set(val, locs);
        }
      }
      if (Node.isStringLiteral(node)) {
        const val = node.getText();
        // Only flag strings longer than 5 chars (skip short labels)
        if (val.length > 7 && !val.includes('\n')) {
          const locs = literalLocations.get(val) ?? [];
          locs.push({ file, line: node.getStartLineNumber() });
          literalLocations.set(val, locs);
        }
      }
    });
  }

  // Report values appearing in 2+ files
  for (const [value, locs] of literalLocations) {
    const uniqueFiles = new Set(locs.map(l => l.file));
    if (uniqueFiles.size >= 2) {
      const locations = locs.map(l => `  ${l.file}:${l.line}`).join('\n');
      violations.push(`Duplicate literal "${value}" in ${uniqueFiles.size} files:\n${locations}`);
    }
  }

  return { passed: violations.length === 0, violations };
}
```

- [ ] **Step 3: Wire into the main check pipeline**

Add the call in the main `check()` function:

```typescript
const dupResult = checkDuplicateLiterals();
checks.push(dupResult);
```

- [ ] **Step 4: Run check:arch to verify it passes**

```bash
bun run check:arch
```

Expected: PASS (all duplicates should already be resolved by Tasks 1-9).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-architecture.ts
git commit -m "feat: add duplicate literal detection to architecture checker"
```

---

### Task 14: Final verification and consolidation

**Files:**
- All modified files

- [ ] **Step 1: Run full quality gate**

```bash
bun run check:all
```

Expected: PASS (type check + tests + arch checks all green).

- [ ] **Step 2: Run lint with magic numbers rule**

```bash
bun run lint
```

Expected: PASS with zero magic number violations.

- [ ] **Step 3: Verify all constants follow naming convention**

Run a quick check:

```bash
git diff master --stat
```

Review that all new `const` declarations use UPPER_SNAKE_CASE.

- [ ] **Step 4: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for magic number governance"
```

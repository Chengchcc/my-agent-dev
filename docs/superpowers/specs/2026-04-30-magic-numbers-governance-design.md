# Magic Number & String Governance + Anti-Corruption

**Status:** approved  
**Date:** 2026-04-30

## Goal

Eliminate magic numbers and bare string literals (closed sets) from the codebase, then install anti-corruption measures to prevent them from returning.

## Scope

### What gets extracted

- All numeric literals except: -1, 0, 1, 2 (loop/index/offset), 100 (percentage denominator), 1000 (ms conversion factor), array `.length` comparisons
- All string literals that appear in more than one file
- All string literals that form a closed set (profiles, statuses, event types, provider names, tool names, model names)

### What is exempt

- Single-occurrence config defaults in `defaults.ts` and `schema.ts` where the key already describes the value
- Test file assertion values (tests are their own documentation)
- `.min()` / `.max()` constraints in Zod schemas (schema declaration is the documentation)

## Organization

Follow existing convention — **co-locate with consuming code**, not a central dump file.

Three patterns:

```typescript
// Pattern A: Module-private scalar (most cases)
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

// Pattern B: Shared constant group → domain types file, exported
export const TOKEN_ESTIMATES = {
  read: 100,
  grep: 3000,
  glob: 1000,
} as const;

// Pattern C: Closed string set → const array + type alias
export const SUB_AGENT_PROFILES = ['read_only', 'code_editor', 'general'] as const;
export type SubAgentProfile = (typeof SUB_AGENT_PROFILES)[number];
```

### Deduplication targets

| Value | Files | Resolution |
|---|---|---|
| `5381` (DJB2 seed) | `memory/middleware.ts`, `skills/middleware.ts` | Extract to `src/utils/hash.ts` |
| `4096` (maxTokens) | `defaults.ts`, `schema.ts`, `claude.ts`, `openai.ts`, `runtime.ts` | Shared constant in `config/` |
| `0.7` (temperature) | `defaults.ts`, `schema.ts`, `claude.ts`, `openai.ts` | Shared constant in `config/` |
| `'claude-3-5-haiku-20241022'` | `runtime.ts`, `memory/extractor.ts` | Shared constant in `config/` |
| `maxTurns: 25` | `loop-types.ts`, `bin/my-agent.ts` | Derive CLI default from loop config |

## Anti-Corruption Layers

### Layer 1 — ESLint

Enable `@typescript-eslint/no-magic-numbers` in `eslint.config.js`:
- `ignore: [-1, 0, 1, 2]`
- `ignoreEnums: true`
- `ignoreNumericLiteralTypes: true`
- `ignoreReadonlyClassProperties: true`
- Exempt files: `src/config/defaults.ts`, `src/config/schema.ts`, `tests/**`

### Layer 2 — CI pipeline (new)

Create `.github/workflows/check.yml`:
- Runs `bun run check:all` (tsc + tests + arch checks + lint)
- Runs on PR to master

### Layer 3 — Architecture Constitution

Add to Section I (Forbidden Patterns):
> **I6. Magic numbers and bare closed-set strings.** Numeric literals (beyond -1/0/1/2) must be named constants. String literals that form a closed set must use `as const` arrays with derived types. Duplicate literal occurrences across files must be consolidated.

### Layer 4 — `check:arch` script

New check: detect duplicate numeric and string literals across files. Report any number or closed-set string that appears verbatim in 2+ files (excluding whitelist values). This catches re-introduction of shared magic values.

## Implementation order

1. Extract cross-file duplicates to shared constants (DJB2 seed, maxTokens, temperature, model names)
2. Extract in-file magic numbers to module-level constants, file by file (tools → agent → compaction → TUI → memory → providers → skills → bin)
3. Extract closed-set string literals to `as const` arrays with derived types
4. Configure ESLint `no-magic-numbers` rule
5. Create CI workflow
6. Update Architecture Constitution
7. Update `check:arch` script with duplicate literal detection

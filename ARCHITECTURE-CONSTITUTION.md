# Architecture Constitution
## (Violation = CI Failure, Cannot Be Bypassed)

**This document contains mandatory, non-negotiable architectural constraints for all AI-generated code in this repository. Every rule is enforced by `bun run check:all` — violations will block your PR.**

This project is in an anti-fragmentation governance period. The following constraints are **mandatory** for all AI-generated code.

---

## A. Entry Point and Assembly (Single Source of Truth)
- **Single assembly function**: `createAgentRuntime()` (`src/runtime.ts`).
- `bin/*` may only: parse CLI parameters → call `createAgentRuntime` → consume the `AgentEvent` stream.
- Do NOT directly instantiate `new Agent()`, `new ToolRegistry()`, `new ContextManager()`, `new ClaudeProvider()`, or `new OpenAIProvider()` inside `bin/*`.
- Configuration source priority: `settings.json` < environment variables < CLI parameters. All three must share the same reading logic (`src/config/`).

## B. Type Safety
- No new `as any`, `: any`, or `<any>` casts. Existing `any` usage is permitted during the migration period, but do not add more.
- No "assertion-style interface patching" like `(x as SomeType & { ... })` — if a public API is missing, add it to the type definition instead of casting.
- `AgentEvent` must remain a discriminated union; consumers must use `switch(event.type)` + exhaustive `never` check. No `(event as any).xxx`.

## C. Hook / Middleware Freeze
- The current 6 Agent hook points (`beforeAgentRun` / `beforeCompress` / `beforeModel` / `afterModel` / `beforeAddResponse` / `afterAgentRun`) are **frozen**. New hook points require an RFC (proposed in `docs/rfc/`).
- `beforeCompress` is being merged into `beforeModel` — do not add new calls.
- The `middleware` field in the Agent constructor is deprecated, do not use it; always use `hooks.beforeModel`.
- Tool middleware registration order determines semantics (`permission` must be outermost). New middleware must declare its required order in the PR description.

## D. ToolDispatcher Freeze
- The `ToolDispatcher` method set is frozen: `dispatch` / `executeSingle` / `buildMiddlewareChain` / `withTimeout` / `serializeAndTruncate` / three `dispatch*` branches.
- No new dispatch branches; any new concurrency/streaming strategy must be expressed via two parameters: `concurrency: number` + `yieldMode: 'streaming' | 'batch'`.
- Tool concurrency must have an upper limit (`maxParallel`, default 8). No unbounded concurrency.

## E. State Consistency
- Todo state normalization is in progress. **Do NOT add new `syncTodoFromContext` call sites**. Mark with TODO in PR if you encounter this function while fixing bugs, do not spread it.
- No "dual writing context and contextManager" (e.g., `ctx.messages = x; contextManager.setMessages(x)` appearing together). Only write to contextManager, then read via `getContext()`.

## F. DRY / Dead Code
- When fixing bugs, if you find duplicate code (e.g., provider assembly, prompt constants), **it must be consolidated**. Do not "just copy one more time".
- `tsc --noUnusedLocals` is a hard threshold — unused imports/variables cannot be merged.
- Unused exports reported by `knip` must be cleaned or annotated with `// @public` comment.

## G. Size Control
- Single file > 400 lines: PR must justify or split (enforced by eslint `max-lines`).
- Single function > 80 lines: must be split (enforced by eslint `max-lines-per-function`).
- `Agent.runAgentLoop` is being split into `runSetupPhase` / `runTurn` / `runTeardown`. Only bug fixes during this period, no new features.

## H. Testing Threshold
- New public APIs (exported classes/functions) must include unit tests in the corresponding path under `tests/`.
- Bug fixes must first write a reproduction case in `tests/regression/`, and include the original failure output in the PR.
- Test coverage for the three core files `dispatcher.ts` / `Agent.ts` / `runtime.ts` must not decrease.

## I. Forbidden Patterns
The following code patterns appearing in diffs will be directly blocked by `check:arch`:
- `new Agent(` appearing in business code outside `bin/` or `tests/`
- `as any` or `: any`
- New calls to `syncTodoFromContext`
- `console.log` (use `debugLog` or structured logger)
- `// @ts-ignore` / `// @ts-expect-error` without justification comment

## J. Requirements for AI Coding Assistants
- Before any refactoring, run `git grep` to find similar implementations, prioritize reuse.
- Before modifying `Agent.ts` / `dispatcher.ts` / `runtime.ts`, **you must read the entire file first**.
- Before completing a task, self-check against §A–I and list violations in the final response.
- If you need to bypass a constraint, you must write "RFC: <reason>" in the PR description for human approval.

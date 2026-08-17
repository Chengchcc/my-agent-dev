# Agent Backend + Oma Rewrite Plans

## Start here

1. Execute [Phase 0](./phase-0-one-agent-backend-language.md).
2. After Phase 0, Phase 1 and Phase 2 may run in parallel worktrees.
3. Do not start Product caller cutover before Phase 4 passes.

## Visible progress

| Phase | Plan | Result | Estimated focused time |
|---|---|---|---:|
| 0 | [One Agent Backend Language](./phase-0-one-agent-backend-language.md) | Shared Run input/event/outcome contract | See plan |
| 1 | [Durable Agent Context and Runs](./phase-1-durable-agent-context-and-runs.md) | Product facts, branches, runs, queue | See plan |
| 2 | [Complete Oma](./phase-2-complete-oma.md) | New loop/session/model/tool runtime | See plan |
| 3 | [Oma Runs Independently](./phase-3-oma-runs-independently.md) | Independent service + Worker + Adapter | See plan |
| 4 | [Product Backend Executes Agent Runs](./phase-4-product-backend-executes-agent-runs.md) | Run execution, Product Tools, atomic commit | See plan |
| 5 | [All Product Flows Use Agent Runs](./phase-5-all-product-flows-use-agent-runs.md) | Conversation/Cron/Loop/Skill Pack cutover; 续：Run-centric rewrite（child-process CLI） | See plan |
| 6 | [Only New Execution Remains](./phase-6-only-new-execution-remains.md) | Old Agent/checkpoint path deleted | See plan |

## Dependency graph

```text
Phase 0
  ├─ Phase 1
  │    └─ Phase 4
  │         └─ Phase 5
  │              └─ Phase 6
  │
  └─ Phase 2
       └─ Phase 3
            └─ Phase 4
```

## Execution rules

1. One task card at a time. Do not start the next card before its `Done when` is true.
2. Use the card’s focused check first. Run broad gates only where the plan says so.
3. A failed check is the next task. Do not hide it with `any`, `@ts-ignore`, fallback, alias, or dual-write.
4. Phase 5 is the only Product caller cutover. Earlier phases must not migrate Conversation, Cron, Loop, Skill Pack, Web, or Lark callers.
5. Phase 6 is destructive. Confirm Product facts and smoke paths before deleting old DB/cache/API/docs.

## State reminder

```text
Public facts:
Conversation History + Agent Context + Agent Run

Execution:
Agent Backend → Claude Code / Codex / OpenCode / Oma

Internal caches:
execution session + Coding Session
```

## Source specs

- `docs/superpowers/specs/agent-backend-oma-rewrite/README.md`
- `docs/architecture/README.md`

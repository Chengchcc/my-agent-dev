---
name: loop-workflow
description: >
  Drive one loop generation round as an in-process workflow: fan out fixes
  per item, self-evaluate each with a verdict agent, retry bounded by the
  item attempt budget. The product validates the meta writeback.
user_invocable: false
---

# Loop Workflow

One loop step = one `workflow_run` invocation. The script below is the
canonical orchestration; copy it into `.workflows/loop.js` in the agent
workspace and adapt per-loop.

## Contract with the product

- `meta.items` carries the loop's per-instance state (item id/summary/
  step/attempt). The product seeds it from STATE.md before the run.
- After the run, the product reads the script's `meta` and validates the
  writeback with `validateLoopMetaPatch` (packages/loop). Only legal
  step edges and `triaged`-entry additions are accepted; removals and
  regressions are rejected.
- You never free-write state: the product is the only meta authority.

## Rules

- Each item gets ONE generation agent (smallest possible diff) and ONE
  evaluator agent (assume the fix is broken until tests prove otherwise).
- Retry at most the item's remaining attempt budget; two no-progress
  rounds stop the workflow.
- Subagents share the workspace: shard by file so parallel fixes never
  overlap.
- Budget: the workflow executor enforces the product budget gate; the
  script must not spawn unbounded agents.

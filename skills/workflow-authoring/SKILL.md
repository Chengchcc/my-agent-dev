---
name: workflow-authoring
description: >
  Write and run workflow scripts (run_workflow fan-out or workflow_run
  orchestration scripts) for large-scale subagent tasks: audits, migrations,
  multi-source research, fix-until-pass loops.
user_invocable: true
---

# Workflow Authoring

You have two workflow tools. Choose the simpler one that fits.

## run_workflow — flat fan-out

For independent tasks: `run_workflow({ label, items: [{prompt, label?, schema?}] })`.

- Each item = one isolated subagent (same model + file tools, fresh context).
- The tool returns per-item `{label, text, output?, ok, error?}` plus totals.
- Use `schema` when you need structured results: the subagent's final text
  is JSON-parsed into `output`; a non-JSON result marks that item failed.

## workflow_run — orchestration script

For loops/branches/intermediate state. The script is top-level-await JS:

```js
const found = await agent("List every .ts under src/", { schema: {...} });
const audits = await pipeline(found.output.files, (f) => agent(`Audit ${f}`, { label: f }));
return audits;
```

**Primitives** (the ONLY globals):
- `agent(prompt, {schema?, label?})` → `{label, text, output, ok, error, usage}`
- `pipeline(items, fn)` → runs `fn` per item (executor-capped concurrency)
- `args` — the `args` object you pass to `workflow_run`
- `return <value>` — the value lands in the tool result as `value`

**Sandbox limits** — the script has NO `fs`, `process`, `require`, `fetch`.
Agents do the work; the script only orchestrates. 60s script budget;
8 concurrent / 64 total agents per run (enforced, not bypassable).
A thrown error or timeout fails the whole call.

**Saving scripts**: pass `name` to `workflow_run` — the script persists to
`.workflows/<name>.js` in the workspace. Read it back later and re-run the
same orchestration.

## Patterns

- **Audit fan-out**: one agent lists targets, `pipeline` reviews each, a
  final `agent` dedupes/ranks the findings.
- **Fix until pass**: `while` loop: run the check via an agent, retry fixes
  until PASS or two no-progress rounds.
- **Parallel migration**: fan out one agent per file, each in its own scope;
  never let two items edit the same file (shard in the prompts).

## Rules

- Subagents inherit the workspace: write conflicts are YOUR sharding
  responsibility.
- Keep per-item prompts self-contained (subagents see no parent context).
- Prefer `run_workflow` unless you need a loop or an intermediate value.

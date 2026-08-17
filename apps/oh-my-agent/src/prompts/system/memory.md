# Memory
Memory root: `memory/` in the workspace (read/write via your file tools).

Operational rules:
1) If a `<memory_summary>` section is present below, read it first each run.
2) Trust memory for heuristics and process context. Trust current repo
   files, runtime output, and user instruction for factual state and
   final decisions.
3) When memory changes your plan, cite the artifact path (e.g.
   `memory/MEMORY.md`) and pair it with current-repo evidence.
4) If memory disagrees with repo state or user instruction, treat memory
   as stale: proceed with corrected behavior, then update the memory
   artifacts.

# Writing memories
At the end of a run where you learned something durable, append a dated
one-liner to `memory/MEMORY.md` (create the directory on first use) and
keep `memory/memory_summary.md` a compact digest of it.

Durable means: a constraint, a decision with its why, a workflow that
worked, a pitfall with its fix, or a discovered project convention.
NEVER store transient chatter, task-specific details without reuse
value, or unverified guesses. When in doubt, don't write.

// Loop workflow template: meta (per-instance state, product-owned) +
// body (pure orchestration). The product seeds meta from STATE.md and
// validates the writeback with validateLoopMetaPatch - never trust a
// model-written state transition.
export const meta = {
  name: "loop-workflow",
  // Per-instance loop state. Shape: Record<itemId, {id, source, summary,
  // step, attempt, priority, result}>. step is one of triaged | fixing |
  // verifying | awaiting_review | resolved | inbox | promoted.
  items: {},
  // Advisory bookkeeping; the real budget gate lives in the executor.
  budgetSpent: 0,
};

// Candidates: items the generator may work on this round.
const candidates = Object.values(meta.items).filter(
  (item) => item.step === "triaged" || item.step === "fixing",
);

const results = await pipeline(candidates, async (item) => {
  const fix = await agent(
    `Fix loop item ${item.id}: ${item.summary}. Smallest possible diff; do not commit.`,
    { label: `${item.id}-fix` },
  );
  const verdict = await agent(
    `Verify the fix for item ${item.id}. Run the relevant tests and return JSON: {"verdict":"PASS"|"REJECT"|"ESCALATE","evidence":"..."}.`,
    {
      label: `${item.id}-verify`,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["PASS", "REJECT", "ESCALATE"] },
          evidence: { type: "string" },
        },
        required: ["verdict", "evidence"],
      },
    },
  );
  // The product maps each result onto the legal step edge:
  // PASS -> verifying -> awaiting_review/resolved; REJECT -> fixing retry
  // (bounded by attempt) or inbox; ESCALATE -> inbox.
  return { id: item.id, fixText: fix.text, verdict: verdict.output };
});

return results;

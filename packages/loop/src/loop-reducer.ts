import type { LoopAction, LoopState } from "./types.js";

type ReducerOpts = {
  maxRetries?: number;
  autoResolve?: boolean;
};

const DEFAULT_MAX_RETRIES = 3;

function cloneItems(items: LoopState["items"]): LoopState["items"] {
  return { ...items };
}

function isEvidenceEmpty(evidence: string): boolean {
  return evidence.trim().length === 0;
}

export function loopReducer(state: LoopState, action: LoopAction, opts?: ReducerOpts): LoopState {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const autoResolve = opts?.autoResolve ?? false;
  const items = cloneItems(state.items);

  switch (action.type) {
    // --- TICK: all triaged → fixing ---
    case "TICK": {
      for (const id of Object.keys(items)) {
        const item = items[id]!;
        if (item.step === "triaged") {
          items[id] = { ...item, step: "fixing" };
        }
      }
      break;
    }

    // --- GENERATOR_DONE: fixing → verifying, clear result ---
    case "GENERATOR_DONE": {
      const item = items[action.itemId];
      if (item?.step === "fixing") {
        items[action.itemId] = {
          ...item,
          step: "verifying",
          result: null,
          generatorRunId: action.generatorRunId ?? item.generatorRunId,
        };
      }
      break;
    }

    // --- EVALUATOR_VERDICT ---
    case "EVALUATOR_VERDICT": {
      const item = items[action.itemId];
      if (item?.step !== "verifying") break;

      const { verdict, evaluatorRunId } = action;

      if (verdict.verdict === "PASS") {
        if (isEvidenceEmpty(verdict.evidence)) {
          items[action.itemId] = {
            ...item,
            evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
            step: "inbox",
            result: {
              verdict: "ESCALATE",
              reasons: ["PASS verdict missing evidence"],
              evidence: "",
            },
          };
          break;
        }
        items[action.itemId] = {
          ...item,
          evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
          step: autoResolve ? "resolved" : "awaiting_review",
          result: verdict,
        };
      } else if (verdict.verdict === "REJECT") {
        if (item.attempt >= maxRetries) {
          items[action.itemId] = {
            ...item,
            evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
            step: "inbox",
            result: verdict,
          };
        } else {
          items[action.itemId] = {
            ...item,
            evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
            step: "fixing",
            attempt: item.attempt + 1,
            result: verdict,
          };
        }
      } else {
        // ESCALATE
        items[action.itemId] = {
          ...item,
          evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
          step: "inbox",
          result: verdict,
        };
      }
      break;
    }

    // --- APPROVE: awaiting_review → resolved ---
    case "APPROVE": {
      const item = items[action.itemId];
      if (item?.step === "awaiting_review") {
        items[action.itemId] = { ...item, step: "resolved" };
      }
      break;
    }

    // --- REJECT_HUMAN: awaiting_review → inbox ---
    case "REJECT_HUMAN": {
      const item = items[action.itemId];
      if (item?.step === "awaiting_review") {
        items[action.itemId] = {
          ...item,
          step: "inbox",
          result: {
            verdict: "REJECT",
            reasons: [action.feedback ?? "手动驳回"],
            evidence: "",
          },
        };
      }
      break;
    }

    // --- PROMOTE: awaiting_review → promoted ---
    case "PROMOTE": {
      const item = items[action.itemId];
      if (item?.step === "awaiting_review") {
        items[action.itemId] = { ...item, step: "promoted" };
      }
      break;
    }

    // --- RETRY: inbox → triaged ---
    case "RETRY": {
      const item = items[action.itemId];
      if (item?.step === "inbox") {
        items[action.itemId] = {
          ...item,
          step: "triaged",
          attempt: 1,
          result: null,
        };
      }
      break;
    }

    // --- DISMISS: inbox → remove ---
    case "DISMISS": {
      const item = items[action.itemId];
      if (item?.step === "inbox") {
        delete items[action.itemId];
      }
      break;
    }

    // --- ADD_ITEM: add new, reject conflict ---
    case "ADD_ITEM": {
      const newId = action.item.id;
      if (items[newId]) break;
      items[newId] = {
        ...action.item,
        step: "triaged",
        attempt: 1,
        priority: action.priority ?? 0,
        result: null,
      };
      break;
    }
  }

  return { ...state, items };
}

// ─── Meta writeback validation (workflow consumer) ─────────────────────

/** The state machine's step edges. REJECT retries legitimately move
 *  verifying → fixing (a "backward" edge in any linear order), so the
 *  validator uses the EDGE SET, not a sequence index. */
const LEGAL_STEP_EDGES: Record<ItemStep, readonly ItemStep[]> = {
  inbox: ["promoted", "triaged"],
  promoted: ["triaged"],
  triaged: ["fixing"],
  fixing: ["verifying"],
  verifying: ["resolved", "awaiting_review", "fixing", "inbox"],
  awaiting_review: ["resolved", "inbox"],
  resolved: [],
};

const ITEM_STEPS: readonly string[] = ["triaged", "fixing", "verifying", "awaiting_review", "resolved", "inbox", "promoted"];
const VERDICTS: readonly string[] = ["PASS", "REJECT", "ESCALATE"];

/** Validate a workflow script's meta writeback against the pure state
 *  machine invariants. The model can never free-write loop state: only
 *  ADD_ITEM semantics (new ids entering at `triaged`) and legal step
 *  edges are accepted; item removal is rejected (the loop owns dismissal). */
export function validateLoopMetaPatch(
  before: LoopState,
  after: LoopState,
): { ok: true } | { ok: false; reason: string } {
  for (const id of Object.keys(before.items)) {
    if (!(id in after.items)) {
      return { ok: false, reason: `item ${id} was removed - the loop owns dismissal` };
    }
  }
  for (const [id, item] of Object.entries(after.items)) {
    if (!ITEM_STEPS.includes(item.step)) {
      return { ok: false, reason: `item ${id} has an unknown step: ${String(item.step)}` };
    }
    if (item.result && !VERDICTS.includes(item.result.verdict)) {
      return { ok: false, reason: `item ${id} has an unknown verdict: ${String(item.result.verdict)}` };
    }
    const prev = before.items[id];
    if (!prev) {
      // New item: the ADD_ITEM contract enters at `triaged` only.
      if (item.step !== "triaged") {
        return { ok: false, reason: `new item ${id} must enter at triaged, got ${item.step}` };
      }
      continue;
    }
    if (prev.step === item.step) continue; // field-only patches (result/attempt)
    if (!LEGAL_STEP_EDGES[prev.step].includes(item.step)) {
      return {
        ok: false,
        reason: `item ${id} cannot move ${prev.step} -> ${item.step}`,
      };
    }
  }
  return { ok: true };
}

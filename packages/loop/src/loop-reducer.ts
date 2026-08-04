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
          generatorSpanId: action.generatorSpanId ?? item.generatorSpanId,
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
            ...item, evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
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
          ...item, evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
          step: autoResolve ? "resolved" : "awaiting_review",
          result: verdict,
        };
      } else if (verdict.verdict === "REJECT") {
        if (item.attempt >= maxRetries) {
          items[action.itemId] = {
            ...item, evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
            step: "inbox",
            result: verdict,
          };
        } else {
          items[action.itemId] = {
            ...item, evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
            step: "fixing",
            attempt: item.attempt + 1,
            result: verdict,
          };
        }
      } else {
        // ESCALATE
        items[action.itemId] = {
          ...item, evaluatorRunId: evaluatorRunId ?? item.evaluatorRunId,
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

// === Item identity ===
export type ItemId = string; // ULID, e.g. "01JN7X8K3M..."

// === Item step ===
export type ItemStep =
  | "triaged"
  | "fixing"
  | "verifying"
  | "awaiting_review"
  | "resolved"
  | "inbox"
  | "promoted";

// === Evaluator verdict ===
export type Verdict =
  | { verdict: "PASS"; evidence: string }
  | { verdict: "REJECT"; reasons: string[]; evidence: string }
  | { verdict: "ESCALATE"; reasons: string[]; evidence: string };

// === Single item ===
export type ItemState = {
  id: ItemId;
  source: string;
  summary: string;
  step: ItemStep;
  attempt: number;
  priority: number;
  result: Verdict | null;
  generatorRunId?: string;
  evaluatorRunId?: string;
};

// === Loop state ===
export type LoopState = {
  loopId: string;
  lastRun: string | null;
  items: Record<ItemId, ItemState>;
};

// === Actions ===
export type LoopAction =
  | { type: "TICK" }
  | { type: "GENERATOR_DONE"; itemId: ItemId; generatorRunId?: string }
  | { type: "EVALUATOR_VERDICT"; itemId: ItemId; verdict: Verdict; evaluatorRunId?: string }
  | { type: "APPROVE"; itemId: ItemId }
  | { type: "REJECT_HUMAN"; itemId: ItemId; feedback?: string }
  | { type: "PROMOTE"; itemId: ItemId }
  | { type: "RETRY"; itemId: ItemId }
  | { type: "DISMISS"; itemId: ItemId }
  | {
      type: "ADD_ITEM";
      item: Omit<ItemState, "step" | "attempt" | "priority" | "result">;
      priority?: number;
    };

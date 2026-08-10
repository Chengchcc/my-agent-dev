import type { Database } from "bun:sqlite";
import type { ItemState, LoopState, Verdict } from "@my-agent-team/loop";

export interface LoopStateStore {
  load(loopId: string): LoopState;
  save(loopId: string, state: LoopState, inboxItems: Record<string, ItemState>): void;
  addBudget(loopId: string, day: string, delta: number): number;
  getBudget(loopId: string, day: string): number;
  getBudgetHistory(loopId: string, days?: number): Array<{ date: string; spent: number }>;
  /** Remove all Loop state (items + budget). Runs the same transaction as
   *  the caller's cron-row delete when composed by the route handler. */
  delete(loopId: string): void;
}

export function createLoopStateStore(db: Database): LoopStateStore {
  const loadAll = db.query<
    {
      item_id: string;
      source: string;
      summary: string;
      step: string;
      attempt: number;
      priority: number;
      result: string | null;
      generator_run_id: string | null;
      evaluator_run_id: string | null;
      updated_at: number;
    },
    [string]
  >(
    "SELECT item_id, source, summary, step, attempt, priority, result, generator_run_id, evaluator_run_id, updated_at FROM loop_item WHERE loop_id = ?",
  );

  const upsertItem = db.query<
    void,
    [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      string | null,
      string | null,
      string | null,
      number,
    ]
  >(
    `INSERT INTO loop_item(loop_id, item_id, source, summary, step, attempt, priority, result, generator_run_id, evaluator_run_id, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loop_id, item_id) DO UPDATE SET
       step=excluded.step, attempt=excluded.attempt, priority=excluded.priority,
       result=excluded.result, generator_run_id=excluded.generator_run_id,
       evaluator_run_id=excluded.evaluator_run_id, updated_at=excluded.updated_at`,
  );

  const deleteItem = db.query<void, [string, string]>(
    "DELETE FROM loop_item WHERE loop_id = ? AND item_id = ?",
  );

  const upsertBudget = db.query<{ spent: number }, [string, string, number]>(
    `INSERT INTO loop_budget(loop_id, day, spent) VALUES(?, ?, ?)
     ON CONFLICT(loop_id, day) DO UPDATE SET spent = spent + excluded.spent
     RETURNING spent`,
  );

  const selectBudget = db.query<{ spent: number }, [string, string]>(
    "SELECT spent FROM loop_budget WHERE loop_id = ? AND day = ?",
  );

  const budgetHistoryQuery = db.query<{ day: string; spent: number }, [string, number]>(
    "SELECT day, spent FROM loop_budget WHERE loop_id = ? ORDER BY day DESC LIMIT ?",
  );

  function rowToItem(row: {
    item_id: string;
    source: string;
    summary: string;
    step: string;
    attempt: number;
    priority: number;
    result: string | null;
    generator_run_id: string | null;
    evaluator_run_id: string | null;
  }): ItemState {
    let result: Verdict | null = null;
    if (row.result) {
      try {
        result = JSON.parse(row.result) as Verdict;
      } catch {
        /* ignore */
      }
    }
    return {
      id: row.item_id,
      source: row.source,
      summary: row.summary,
      step: row.step as ItemState["step"],
      attempt: row.attempt,
      priority: row.priority,
      result,
      generatorRunId: row.generator_run_id ?? undefined,
      evaluatorRunId: row.evaluator_run_id ?? undefined,
    };
  }

  return {
    load(loopId: string): LoopState {
      const rows = loadAll.all(loopId);
      const items: Record<string, ItemState> = {};
      for (const row of rows) {
        items[row.item_id] = rowToItem(row);
      }
      const lastRun =
        rows.length > 0 ? new Date(Math.max(...rows.map((r) => r.updated_at))).toISOString() : null;
      return { loopId, lastRun, items };
    },

    save(loopId: string, state: LoopState, inboxItems: Record<string, ItemState>): void {
      const now = Date.now();
      const tx = db.transaction(() => {
        const keptIds = new Set([...Object.keys(state.items), ...Object.keys(inboxItems)]);
        const existingRows = loadAll.all(loopId);
        for (const row of existingRows) {
          if (!keptIds.has(row.item_id)) {
            deleteItem.run(loopId, row.item_id);
          }
        }

        for (const item of Object.values(state.items)) {
          if (item.step === "resolved" || item.step === "promoted") {
            deleteItem.run(loopId, item.id);
          }
        }

        for (const item of Object.values(state.items)) {
          // resolved/promoted are terminal — already deleted above. inbox can
          // arrive at runtime (REJECT exhausted, ESCALATE, PASS no-evidence)
          // and must be persisted as inbox, not skipped.
          if (item.step === "resolved" || item.step === "promoted") continue;
          upsertItem.run(
            loopId,
            item.id,
            item.source,
            item.summary,
            item.step,
            item.attempt,
            item.priority,
            item.result ? JSON.stringify(item.result) : null,
            item.generatorRunId ?? null,
            item.evaluatorRunId ?? null,
            now,
          );
        }

        for (const item of Object.values(inboxItems)) {
          upsertItem.run(
            loopId,
            item.id,
            item.source,
            item.summary,
            "inbox",
            item.attempt,
            item.priority,
            item.result ? JSON.stringify(item.result) : null,
            item.generatorRunId ?? null,
            item.evaluatorRunId ?? null,
            now,
          );
        }
      });
      tx();
    },

    addBudget(loopId: string, day: string, delta: number): number {
      return upsertBudget.get(loopId, day, delta)!.spent;
    },

    getBudget(loopId: string, day: string): number {
      const row = selectBudget.get(loopId, day);
      return row?.spent ?? 0;
    },
    getBudgetHistory(loopId: string, days = 7): Array<{ date: string; spent: number }> {
      const rows = budgetHistoryQuery.all(loopId, days) as Array<{ day: string; spent: number }>;
      return rows.map((r) => ({ date: r.day, spent: r.spent }));
    },
    delete(loopId: string) {
      db.transaction(() => {
        db.query("DELETE FROM loop_item WHERE loop_id = ?").run(loopId);
        db.query("DELETE FROM loop_budget WHERE loop_id = ?").run(loopId);
      })();
    },
  };
}

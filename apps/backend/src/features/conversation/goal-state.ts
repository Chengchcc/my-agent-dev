/** Work summary produced by the (removed) goal plugin - kept as a plain
 *  UI state shape for the conversation goal panel. */
export interface WorkSummary {
  changed_files: string[];
  commands_run: string[];
  test_result: "pass" | "fail" | "unknown";
  summary: string;
}

import type { SettingsService } from "../settings/service.js";

export interface GoalHistoryEntry {
  turn: number;
  summary: WorkSummary;
  met: boolean;
  reason: string;
  ts: number;
}

export interface GoalState {
  condition: string | null;
  paused: boolean;
  turns: number;
  tokens: number;
  history: GoalHistoryEntry[];
}

export interface GoalStateStore {
  get(conversationId: string): GoalState;
  clear(conversationId: string): void;
  /** Persist condition + paused to survive restart. */
  savePersistent(conversationId: string, condition: string | null, paused: boolean): void;
}

/** Persisted subset: condition + paused survive restart.
 *  turns/tokens/history are runtime-only (re-accumulated on resume). */
interface PersistedGoal {
  condition: string | null;
  paused: boolean;
}

const settingsKey = (conversationId: string) => `goal.${conversationId}`;

export function createGoalStateStore(settingsSvc: SettingsService): GoalStateStore {
  // Runtime state: live mutable object. get() returns this ref so caller mutations
  // (gs.turns++, gs.history.push) land in the cache.
  const states = new Map<string, GoalState & { _persisted?: PersistedGoal }>();

  function loadPersisted(conversationId: string): PersistedGoal | undefined {
    return settingsSvc.get<PersistedGoal>(settingsKey(conversationId));
  }

  return {
    get(conversationId: string): GoalState {
      let state = states.get(conversationId);
      if (!state) {
        const persisted = loadPersisted(conversationId);
        state = {
          condition: persisted?.condition ?? null,
          paused: persisted?.paused ?? false,
          turns: 0,
          tokens: 0,
          history: [],
        };
        states.set(conversationId, state);
      }
      return state;
    },

    clear(conversationId: string): void {
      states.delete(conversationId);
      // ponytail: settings has no DELETE, overwrite with cleared state
      settingsSvc.set<PersistedGoal>(settingsKey(conversationId), {
        condition: null,
        paused: false,
      });
    },

    savePersistent(conversationId: string, condition: string | null, paused: boolean): void {
      const state = states.get(conversationId);
      if (state) {
        state.condition = condition;
        state.paused = paused;
      }
      settingsSvc.set<PersistedGoal>(settingsKey(conversationId), { condition, paused });
    },
  };
}

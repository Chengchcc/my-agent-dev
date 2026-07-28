import type { ChatModel } from "@my-agent-team/core";
import { definePlugin, type Plugin } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";
import { generateBark, PetBarkKey, shouldBark } from "./bark.js";
import { awardXP, updateMood } from "./state.js";
import { createInitialState, type PetState } from "./types.js";

export interface PetPluginOptions {
  petModel: ChatModel;
  cwd: string;
  enabled?: boolean;
  /** Settings service for persisting pet state across runs. */
  settings?: PetSettingsStore;
}

export interface PetSettingsStore {
  get(key: string): string | undefined;
  getNumber(key: string): number | undefined;
  set(key: string, value: string): void;
}

export { PetBarkKey } from "./bark.js";
export type { PetBark, PetMood, PetPersistedState, PetState } from "./types.js";

const PET_PREFIX = "pet";

function loadState(store: PetSettingsStore | undefined): PetState {
  const s = createInitialState();
  if (!store) return s;
  s.level = store.getNumber(`${PET_PREFIX}.level`) ?? 1;
  s.xp = store.getNumber(`${PET_PREFIX}.xp`) ?? 0;
  s.totalTurns = store.getNumber(`${PET_PREFIX}.totalTurns`) ?? 0;
  s.totalBarks = store.getNumber(`${PET_PREFIX}.totalBarks`) ?? 0;
  return s;
}

function saveState(store: PetSettingsStore | undefined, state: PetState): void {
  if (!store) return;
  store.set(`${PET_PREFIX}.level`, String(state.level));
  store.set(`${PET_PREFIX}.xp`, String(state.xp));
  store.set(`${PET_PREFIX}.totalTurns`, String(state.totalTurns));
  store.set(`${PET_PREFIX}.totalBarks`, String(state.totalBarks));
}

export function petPlugin(opts: PetPluginOptions): Plugin {
  const enabled = opts.enabled ?? false;
  const state: PetState = loadState(opts.settings);

  return definePlugin({
    name: "pet",
    hooks: {
      async beforeRun(_ctx, messages: readonly Message[]): Promise<Message[]> {
        if (!enabled) return [...messages];
        state.mood = "neutral";
        state.consecutiveErrors = 0;
        state.consecutiveSuccesses = 0;
        state.lastBarkTurn = 0;
        state.turnCount = 0;
        state.lastReviewedMessageCount = 0;
        state.barkHistory = new Set();
        return [...messages];
      },

      async afterTool(_ctx, _call, result, _messages) {
        if (!enabled) return;
        if (result.is_error) {
          state.consecutiveErrors++;
          state.consecutiveSuccesses = 0;
          if (state.consecutiveErrors >= 3) {
            state.mood = "frustrated";
          }
        } else {
          if (state.consecutiveErrors >= 3) {
            state.mood = "neutral";
          }
          state.consecutiveErrors = 0;
          state.consecutiveSuccesses++;
          if (state.consecutiveSuccesses >= 3) {
            state.mood = "happy";
          }
        }
      },

      async afterModel(ctx, messages) {
        if (!enabled) return;

        state.turnCount++;
        state.totalTurns++;

        updateMood(state); // decay happy/excited from previous turn FIRST
        awardXP(state); // may set excited on level-up

        if (shouldBark(state)) {
          const bark = await generateBark(opts.petModel, state, messages);
          if (bark) {
            state.totalBarks++;
            state.lastBarkTurn = state.turnCount;
            const barkData = {
              mood: state.mood,
              text: bark,
              level: state.level,
              turn: state.turnCount,
            };
            ctx.context.set(PetBarkKey, barkData);
            ctx.emit?.({
              type: "pet_bark",
              payload: barkData,
            });
          }
        }

        saveState(opts.settings, state);
      },
    },
  });
}

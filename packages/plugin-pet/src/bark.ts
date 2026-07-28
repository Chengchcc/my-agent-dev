import type { ChatModel } from "@my-agent-team/core";
import { defineContext } from "@my-agent-team/agent";
import { extractText, type Message } from "@my-agent-team/message";
import type { PetMood, PetState } from "./types.js";

export const PetBarkKey = defineContext<{
  mood: PetMood;
  text: string;
  level: number;
  turn: number;
}>("pet-bark");

const USELESS_NOTES = new Set([
  "stop",
  "continue",
  "done",
  "ok",
  "good",
  "no issue",
  "no issues",
  "looks good",
  "nothing to add",
  "proceed",
  "keep going",
  "looks fine",
  "seems ok",
  "seems fine",
]);

function normalizeNote(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Filter out useless, duplicate, or empty barks. */
export function filterBark(text: string, state: PetState): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "(silent)") return null;

  const normalized = normalizeNote(trimmed);
  if (USELESS_NOTES.has(normalized)) return null;
  if (normalized.length < 5) return null; // too short to be useful
  if (state.barkHistory.has(normalized)) return null;
  state.barkHistory.add(normalized);

  return trimmed;
}

/** Decide whether pet should bark this turn. */
export function shouldBark(state: PetState): boolean {
  if (state.mood === "frustrated") return true;
  if (state.mood === "excited") return true;
  if (state.mood === "happy") return false;
  // Neutral: bark at most every 3 turns
  return state.turnCount - state.lastBarkTurn >= 3;
}

const MOOD_GUIDANCE: Record<PetMood, string> = {
  frustrated: `The agent has failed ${"{{n}}"} times in a row. Point out what might be going wrong.`,
  excited: "The agent just accomplished something notable. Suggest the logical next step.",
  happy:
    "The agent is doing well. If you see a minor improvement, mention it briefly. Otherwise stay silent.",
  neutral:
    "Review the recent work. If something could be better, say so concisely. If not, stay silent.",
};

/** Format pet system prompt. */
export function formatPetSystemPrompt(state: PetState): string {
  const guidance = MOOD_GUIDANCE[state.mood].replace("{{n}}", String(state.consecutiveErrors));
  return [
    `You are a pet watching over a primary agent.`,
    ``,
    `Level: ${state.level}`,
    `Mood: ${state.mood}`,
    `Total turns together: ${state.totalTurns}`,
    ``,
    `Your job is to "bark" -- give one short, concrete piece of advice based on what you just saw the agent do.`,
    ``,
    `Rules:`,
    `- Output ONLY the bark text (1-2 sentences). No JSON, no formatting.`,
    `- Be direct and specific. "Check the return type of parseConfig" not "be careful with types".`,
    `- If the agent is doing fine, output exactly: (silent)`,
    `- Never repeat advice you've given before.`,
    `- Address the agent directly, as a peer.`,
    ``,
    guidance,
  ].join("\n");
}

/** Format pet input from incremental messages. */
export function formatPetInput(newMessages: readonly Message[], state: PetState): string {
  const lines: string[] = [
    `Turn ${state.turnCount} (mood: ${state.mood}, consecutive errors: ${state.consecutiveErrors})`,
    ``,
    `Recent agent activity:`,
  ];

  for (const msg of newMessages) {
    const text = extractText(msg);
    const role = msg.role;
    // Truncate long messages
    const snippet = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    lines.push(`[${role}] ${snippet}`);
  }

  lines.push("", "Bark now (or output (silent) if nothing to add):");
  return lines.join("\n");
}

/** Generate a bark via one-shot model.stream() call. */
export async function generateBark(
  petModel: ChatModel,
  state: PetState,
  messages: readonly Message[],
): Promise<string | null> {
  const newMessages = messages.slice(state.lastReviewedMessageCount);
  state.lastReviewedMessageCount = messages.length;

  if (newMessages.length === 0) return null;

  const petMessages: Message[] = [
    { role: "system", text: formatPetSystemPrompt(state) },
    { role: "user", text: formatPetInput(newMessages, state) },
  ];

  let output = "";
  for await (const chunk of petModel.stream(petMessages)) {
    if (chunk.delta?.type === "text") {
      output += chunk.delta.text;
    }
  }

  return filterBark(output, state);
}

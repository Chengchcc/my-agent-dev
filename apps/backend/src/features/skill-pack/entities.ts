import { join } from "node:path";

import { ValidationError } from "../../infra/domain-errors.js";

// ─── Skill Pack domain entities & state machine ────────────────────────────────────

export const BUILTIN_PACK_ID = "builtin";

export type SkillPackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";
export type SkillPackSource = "builtin" | "git" | "zip";

export interface SkillPackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: SkillPackSource;
  sourceUrl: string | null;
  versionRef: string | null;
  installedRef: string | null;
  status: SkillPackStatus;
  error: string | null;
  keepSynced: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSkillPackRow {
  agentId: string;
  packId: string;
  createdAt: number;
}

// ─── State machine ─────────────────────────────────────────────────────────────────

/** Legal transitions. Every transition is source → [valid next states]. */
export const INSTALL_TRANSITIONS: Record<SkillPackStatus, SkillPackStatus[]> = {
  pending: ["installing", "failed"],
  installing: ["ready", "failed"],
  ready: ["syncing"],
  failed: ["installing", "syncing"],
  syncing: ["ready", "failed"],
};

export interface TransitionPatch {
  installedRef?: string;
  error?: string;
}

export class InvalidInstallTransitionError extends ValidationError {
  constructor(cur: SkillPackStatus, next: SkillPackStatus) {
    super(`Invalid install transition: ${cur} -> ${next}`);
  }
}

/**
 * Apply a status transition with optional patch fields.
 * Throws InvalidInstallTransitionError for illegal transitions.
 * The "syncing" transition is only valid for sourceKind='git' — enforced by caller.
 */
export function applyInstallTransition(
  cur: SkillPackStatus,
  next: SkillPackStatus,
  patch?: TransitionPatch,
): { next: SkillPackStatus; installedRef?: string; error?: string | null } {
  const allowed = INSTALL_TRANSITIONS[cur];
  if (!allowed.includes(next)) {
    throw new InvalidInstallTransitionError(cur, next);
  }
  return {
    next,
    installedRef: patch?.installedRef,
    error: patch?.error ?? null,
  };
}

// ─── Path helpers ──────────────────────────────────────────────────────────────────

/** Absolute install path for a pack: <dataDir>/skill-packs/<packId>. Derived, never stored. */
export function installPath(dataDir: string, packId: string): string {
  return join(dataDir, "skill-packs", packId);
}

/** Shared skill root for posixSkillRoot: <dataDir>/skill-packs. */
export function posixSkillRoot(dataDir: string): string {
  return join(dataDir, "skill-packs");
}

import type { SkillPackRow, TransitionPatch } from "./entities.js";

export interface SkillPackPort {
  register(input: {
    id: string;
    name: string;
    description: string;
    sourceKind: SkillPackRow["sourceKind"];
    sourceUrl: string | null;
    versionRef: string | null;
    keepSynced?: boolean;
    now: number;
  }): Promise<SkillPackRow>;

  get(id: string): Promise<SkillPackRow | null>;

  list(): Promise<SkillPackRow[]>;

  applyInstallTransition(
    id: string,
    next: SkillPackRow["status"],
    patch?: TransitionPatch & { now: number },
  ): Promise<SkillPackRow | null>;

  remove(id: string): Promise<boolean>;

  // ─── Agent assignments ───

  /** List pack IDs assigned to an agent (joins skill_pack for full row + agent binding). */
  listForAgent(agentId: string): Promise<SkillPackRow[]>;

  /** Full replacement: overwrite all pack assignments for this agent. */
  setAgentPacks(agentId: string, packIds: string[], now: number): Promise<void>;

  /** Remove all agent assignments for a pack (cascaded on uninstall). */
  removeAgentPack(packId: string): Promise<void>;
}
